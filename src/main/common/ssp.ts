/*
 * Copyright (c) 2025 Xibo Signage Ltd
 *
 * Xibo - Digital Signage - https://xibosignage.com
 *
 * This file is part of Xibo.
 *
 * Xibo is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * any later version.
 *
 * Xibo is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Xibo.  If not, see <http://www.gnu.org/licenses/>.
 */
import { DOMParser, Element as XmlElement } from '@xmldom/xmldom';
import axios from 'axios';
import { createNanoEvents, Emitter } from 'nanoevents';
import { DateTime } from 'luxon';
import { SspAd } from '../xmds/response/schedule/sspAd';
import { Config } from '../config/config';
import { SspAdData } from '../../shared/types';

function getFirstElementChild(el: XmlElement): XmlElement | null {
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i];
    if (child.nodeType === 1) return child as XmlElement;
  }
  return null;
}

interface SspEvents {
  shareOfVoiceChanged: (shareOfVoice: number, averageDuration: number) => void;
}

export default class Ssp {

  emitter: Emitter<SspEvents>;

  interval: NodeJS.Timeout | undefined;
  unwrapInterval: NodeJS.Timeout | undefined;

  isEnabled: boolean = false;
  isAssessing: boolean = false;
  lastFillDate: DateTime = DateTime.now().minus({ days: 30 });

  exchangeUrl: string = 'https://exchange.xibo-adspace.com/vast/device';
  ownerKey: string = '';
  hardwareKey: string = '';

  unwrapRate: number = 0;
  shareOfVoice: number = 0;
  averageDuration: number = 0;
  adSpots: SspAd[] = [];
  ads: SspAd[] = [];
  prefetchUrls: string[] = [];

  config: Config;

  constructor(config: Config) {
    this.config = config;
    this.emitter = createNanoEvents<SspEvents>();
  }

  on<E extends keyof SspEvents>(event: E, callback: SspEvents[E]) {
    return this.emitter.on(event, callback);
  }

  /**
   * Configure the SSP connection.
   * If enabled, start an interval to manage SSP state and request ads.
   */
  async configure(isEnabled: boolean, ownerKey: string, hardwareKey: string | null) {
    this.ownerKey = ownerKey;
    this.hardwareKey = hardwareKey || '';

    if (this.interval !== undefined) {
      clearInterval(this.interval);
    }

    if (!isEnabled || !hardwareKey) {
      this.isEnabled = false;
      this.adSpots = [];
      console.debug('Not enabled.', { method: 'Ssp: configure' });
      return;
    }
    this.isEnabled = true;

    this.interval = setInterval(async () => {
      await this.assess();
    }, 10000);

    await this.assess();
  }

  /**
   * Assess the current state — runs every 10 seconds.
   */
  async assess() {
    if (this.isAssessing) {
      console.info('Still active, skipping', { method: 'Ssp: assess' });
      return;
    }
    this.isAssessing = true;

    console.debug('[Ssp::assess] Assessing', {
      ssp: { adSpots: this.adSpots.length, ads: this.ads.length },
    });

    if (
      (this.adSpots.length <= 2 || this.shareOfVoice == 0) &&
      this.lastFillDate < DateTime.now().minus({ minute: 3 })
    ) {
      console.debug('[Ssp::assess] Fill needed', { method: 'Ssp: assess' });

      this.lastFillDate = DateTime.now();
      this.adSpots = this.adSpots.concat(
        await this.request(
          this.exchangeUrl + '/request/' + this.hardwareKey + '?ownerKey=' + this.ownerKey
        )
      );

      const newUnwrapRate = 3600 / (this.shareOfVoice / this.averageDuration);

      if (!isNaN(newUnwrapRate) && newUnwrapRate !== this.unwrapRate) {
        this.unwrapRate = newUnwrapRate;

        console.debug('[Ssp::assess] New unwrap rate of ' + this.unwrapRate, {
          method: 'Ssp: assess',
        });

        if (this.unwrapInterval !== undefined) {
          clearInterval(this.unwrapInterval);
        }

        this.unwrapInterval = setInterval(async () => {
          await this.unwrapNext();
        }, this.unwrapRate * 1000);

        this.emitter.emit('shareOfVoiceChanged', this.shareOfVoice, this.averageDuration);
      }
    } else {
      console.debug('[Ssp::assess] No fill needed this time', { method: 'Ssp: assess' });
    }

    this.updateSspState();
    this.isAssessing = false;
  }

  async unwrapNext() {
    console.debug('[Ssp::unwrapNext] Unwrap next', { method: 'Ssp: unwrapNext' });

    const adSpot = this.adSpots.pop();

    if (adSpot) {
      const ads = await this.request(adSpot.url, adSpot);

      console.debug('[Ssp::unwrapNext] Requesting ads with adSpot', {
        adsCount: ads.length,
        ads,
      });

      if (ads.length <= 0) {
        await this.reportError(adSpot.errorUrls, 303);
      } else {
        this.ads = this.ads.concat(ads);
      }

      console.debug('[Ssp::unwrapNext] Unwrap complete', { method: 'Ssp: unwrapNext' });
    } else {
      console.error('[Ssp::unwrapNext] No spots to unwrap', { method: 'Ssp: unwrapNext' });
    }

    this.updateSspState();
  }

  async request(url: string, wrappedAd: SspAd | null = null): Promise<SspAd[]> {
    let ads: SspAd[] = [];
    console.debug(
      '[Ssp::request] Starting request, wrapped: ' + (wrappedAd ? 'true' : 'false'),
      { method: 'Ssp: request' }
    );

    let response;
    try {
      if (wrappedAd && wrappedAd.wrapperHttpMethod == 'POST') {
        response = await axios.post(url);
      } else {
        response = await axios.get(url);
      }
    } catch (e) {
      console.error('[Ssp::request] Request failed: ' + (e as Error).message, {
        method: 'Ssp: request',
      });
      return [];
    }

    if (!response) {
      console.error('[Ssp::request] No response to ad request', { method: 'Ssp: request' });
      return [];
    }

    if (!wrappedAd) {
      this.shareOfVoice = parseInt(response.headers['x-adspace-sov'] ?? '0');
      this.averageDuration = parseInt(response.headers['x-adspace-avg-duration'] ?? '0');
    }

    if (response.data) {
      const parser = new DOMParser();
      const rootDoc = parser.parseFromString(response.data, 'text/xml');
      if (!rootDoc.documentElement) {
        return [];
      }
      console.debug('[Ssp::request] Response parsed', {
        method: 'Ssp: request',
        shouldParse: false,
        responseData: response.data,
        parsedResponse: rootDoc,
      });
      Array.from(rootDoc.documentElement.childNodes).forEach((element) => {
        const el = element as XmlElement;
        if (el.nodeType !== 1) {
          return;
        }
        const firstChild = getFirstElementChild(el);
        let ad = new SspAd();
        if (wrappedAd) {
          ad = wrappedAd;
          ad.countWraps++;
        } else {
          ad = new SspAd();
          ad.id = el.getAttribute('id') ?? '0';
        }

        if (firstChild && firstChild.nodeName == 'Wrapper') {
          Array.from(firstChild.childNodes).forEach((wrapperElement) => {
            const wrapEl = wrapperElement as XmlElement;
            if (wrapEl.nodeType !== 1) {
              return;
            }

            if (wrapEl.nodeName == 'VASTAdTagURI') {
              ad.url = wrapEl.textContent?.trim() || '';
            } else if (wrapEl.nodeName == 'Extensions') {
              Array.from(wrapEl.childNodes).forEach((extensionElement) => {
                const extEl = extensionElement as XmlElement;
                if (extEl.nodeType !== 1) {
                  return;
                }
                const extType = extEl.getAttribute('type') || '';

                if (!extEl.textContent || extType == '') {
                  console.error('Empty extension in wrapper: ' + extEl.nodeName, {
                    method: 'Ssp: request',
                  });
                } else if (extType == 'prefetch' || extType == 'xiboPrefetch') {
                  const prefetchUrl = extEl.textContent.trim();
                  if (!this.prefetchUrls.includes(prefetchUrl)) {
                    this.prefetchUrls.push(prefetchUrl);
                  }
                } else if (extType == 'validType' || extType == 'xiboValidType') {
                  ad.wrapperAllowedTypes = extEl.textContent.trim().split(',');
                } else if (extType == 'validDuration' || extType == 'xiboValidDuration') {
                  ad.wrapperAllowedDuration = extEl.textContent.trim();
                } else if (extType == 'xiboMaxDuration') {
                  ad.wrapperMaxDuration = parseInt(extEl.textContent.trim());
                } else if (extType == 'xiboIsWrapperOpenImmediately') {
                  ad.isWrapperOpenImmediately = extEl.textContent.trim() == '1';
                } else if (extType == 'xiboPartner') {
                  ad.wrapperPartner = extEl.textContent.trim();
                } else if (extType == 'xiboFileScheme') {
                  ad.wrapperFileScheme = extEl.textContent.trim();
                } else if (extType == 'xiboExtendUrl') {
                  ad.wrapperExtendUrl = extEl.textContent.trim();
                } else if (extType == 'xiboHttpMethod') {
                  ad.wrapperHttpMethod = extEl.textContent.trim();
                } else if (extType == 'xiboIsWrapperRateLimit') {
                  ad.wrapperRateLimit = parseInt(extEl.textContent.trim());
                } else {
                  console.debug('Unknown extension in wrapper: ' + extEl.nodeName, {
                    method: 'Ssp: request',
                  });
                }
              });
            } else if (wrapEl.nodeName == 'Impression') {
              if (wrapEl.textContent) {
                ad.impressionUrls.push(wrapEl.textContent.trim());
              }
            } else if (wrapEl.nodeName == 'Error') {
              if (wrapEl.textContent) {
                ad.errorUrls.push(wrapEl.textContent.trim());
              }
            } else {
              console.debug('Unknown node in wrapper: ' + wrapEl.nodeName, {
                method: 'Ssp: request',
              });
            }
          });

          ad.isWrapperResolved = false;
        } else if (firstChild && firstChild.nodeName == 'InLine') {
          Array.from(firstChild.childNodes).forEach((inlineElement) => {
            const inEl = inlineElement as XmlElement;
            if (inEl.nodeType !== 1) {
              return;
            }

            if (!inEl.textContent) {
              console.error('Empty node in inline: ' + inEl.nodeName, {
                method: 'Ssp: request',
              });
            } else if (inEl.nodeName == 'AdTitle') {
              ad.title = inEl.textContent.trim();
            } else if (inEl.nodeName == 'Impression') {
              ad.impressionUrls.push(inEl.textContent.trim());
            } else if (inEl.nodeName == 'Error') {
              ad.errorUrls.push(inEl.textContent.trim());
            } else if (inEl.nodeName == 'Creatives') {
              // processed below
            } else if (inEl.nodeName == 'Extensions') {
              Array.from(inEl.childNodes).forEach((extensionElement) => {
                const extEl = extensionElement as XmlElement;
                if (extEl.nodeType !== 1) {
                  return;
                }

                const extType = extEl.getAttribute('type') || '';

                if (!extEl.textContent || extType == '') {
                  console.error('Empty extension in inline: ' + extEl.nodeName, {
                    method: 'Ssp: request',
                  });
                } else if (extType == 'geoFence') {
                  ad.isGeoAware = true;
                  ad.geoLocation = extEl.textContent.trim();
                } else {
                  console.debug('Unknown extension in inline: ' + extEl.nodeName, {
                    method: 'Ssp: request',
                  });
                }
              });
            } else {
              console.debug('Unknown node in inline: ' + inEl.nodeName, {
                method: 'Ssp: request',
              });
            }
          });

          // Pull creatives
          const creatives = Array.from(firstChild.getElementsByTagName('Creative')) as XmlElement[];
          creatives.forEach((creative) => {
            ad.creativeId = creative.getAttribute('id') || 'none';

            (Array.from(creative.getElementsByTagName('Linear')) as XmlElement[]).forEach((linear) => {
              Array.from(linear.childNodes).forEach((linearElement) => {
                const linEl = linearElement as XmlElement;
                if (linEl.nodeType !== 1) {
                  return;
                }

                if (linEl.nodeName == 'Duration') {
                  ad.duration = linEl.textContent?.trim() || '00:00';
                } else if (linEl.nodeName == 'MediaFiles') {
                  (Array.from(linEl.getElementsByTagName('MediaFile')) as XmlElement[]).forEach((mediaFile) => {
                    ad.type = mediaFile.getAttribute('type') || 'unknown';
                    ad.width = parseInt(mediaFile.getAttribute('width') || '0');
                    ad.height = parseInt(mediaFile.getAttribute('height') || '0');
                    ad.url = mediaFile?.textContent?.trim() || '';
                  });
                }
              });
            });
          });

          ad.isWrapperResolved = true;

          if (wrappedAd) {
            if (
              ad.wrapperAllowedTypes.length > 0 &&
              !ad.wrapperAllowedTypes.includes('all') &&
              !ad.wrapperAllowedTypes.includes(ad.type)
            ) {
              this.reportError(ad.errorUrls, 200);
              return;
            }

            if (
              ad.wrapperAllowedDuration &&
              ad.getWrapperAllowedDurationInSeconds() != ad.getDurationInSeconds()
            ) {
              this.reportError(ad.errorUrls, 202);
              return;
            }

            if (ad.wrapperMaxDuration > 0 && ad.getDurationInSeconds() > ad.wrapperMaxDuration) {
              this.reportError(ad.errorUrls, 202);
              return;
            }

            if (ad.type.startsWith('video')) {
              ad.xiboType = 'video';
            } else if (ad.type.startsWith('image')) {
              ad.xiboType = 'image';
            } else {
              this.reportError(ad.errorUrls, 200);
              return;
            }

            const displayAspectRatio = this.config.state.width / this.config.state.height;
            if (ad.getAspectRatio() != displayAspectRatio) {
              this.reportError(ad.errorUrls, 203);
              return;
            }
          }
        } else {
          console.debug(
            'Unknown node in response: ' + (el.firstChild?.nodeName || 'none'),
            { method: 'Ssp: request' }
          );
        }

        ads.push(ad);
      });
    }

    // Recursively unwrap any wrapper ads that need immediate resolution
    let unwrappedAds: SspAd[] = [];
    for (const ad of ads) {
      if (ad.countWraps > 0 && !ad.isWrapperResolved) {
        unwrappedAds = unwrappedAds.concat(await this.request(ad.wrapperAdTagUri, ad));
      } else {
        unwrappedAds.push(ad);
      }
    }

    return unwrappedAds;
  }

  async reportImpression(
    urls: string[],
    duration: number,
    date: DateTime,
    lat: number | null,
    lng: number | null
  ) {
    console.debug('[Ssp::reportImpression] Reporting to ' + urls.length + ' urls', {
      method: 'Ssp: reportImpression',
    });

    urls.forEach((url) => {
      url = url
        .replace('[ACTUAL_IMP]', '1')
        .replace('[DURATION]', '' + duration)
        .replace('[UNIX_TIMESTAMP]', '' + date.toUnixInteger() * 1000)
        .replace('[TIMESTAMP]', '' + date.toUnixInteger())
        .replace('[LAT]', '' + lat)
        .replace('[LNG]', '' + lng);

      console.debug('[Ssp::reportImpression] ' + url, { method: 'Ssp: reportImpression' });
      axios.get(url).catch((e) =>
        console.error('[Ssp::reportImpression] Failed: ' + e.message)
      );
    });
  }

  async reportError(urls: string[], code: number) {
    console.debug(
      '[Ssp::reportError] Reporting to ' + urls.length + ' urls, code: ' + code,
      { method: 'Ssp: reportError' }
    );

    urls.forEach((url) => {
      url = url
        .replace('[TIMESTAMP]', '' + DateTime.now().toUnixInteger())
        .replace('[ERRORCODE]', '' + code);

      console.debug('[Ssp::reportError] ' + url, { method: 'Ssp: reportError' });
      axios.get(url).catch((e) =>
        console.error('[Ssp::reportError] Failed: ' + e.message)
      );
    });
  }

  async getAd(): Promise<SspAdData | null> {
    console.debug('[Ssp::getAd] Get Ad', {
      method: 'Ssp: getAd',
      adSpotsLn: this.adSpots.length,
      adsLn: this.ads.length,
      ads: this.ads,
    });

    const ad = this.ads.pop();

    console.debug('[Ssp::getAd] Ad popped', {
      method: 'Ssp: getAd',
      ad,
    });

    if (ad) {
      const adData: SspAdData = {
        url: ad.url,
        xiboType: ad.xiboType,
        duration: ad.getDurationInSeconds(),
        width: ad.width,
        height: ad.height,
        impressionUrls: ad.impressionUrls,
        errorUrls: ad.errorUrls,
      };

      console.debug('[Ssp::getAd] Returning ad id: ' + ad.id, { method: 'Ssp: getAd' });
      return adData;
    }

    console.info('[Ssp::getAd] No ad available', { method: 'Ssp: getAd' });
    return null;
  }

  updateSspState() {
    if (this.isEnabled) {
      this.config.state.ssp =
        'SOV: ' + this.shareOfVoice +
        ', Buffer: ' + this.adSpots.length +
        ', Unwrap rate: ' + this.unwrapRate +
        ', Ads ready: ' + this.ads.length +
        ', Last fill: ' + this.lastFillDate.toISO();
    } else {
      this.config.state.ssp = 'Disabled';
    }
  }
}
