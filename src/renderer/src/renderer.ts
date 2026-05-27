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
import './assets/fonts.css';
import './assets/main.css';
import '@xibosignage/xibo-layout-renderer/dist/styles.css';

import $ from 'jquery';
import XiboLayoutRenderer, { ConsumerPlatform, ELayoutState, InputLayoutType, IXlr, OptionsType } from '@xibosignage/xibo-layout-renderer';
import DefaultLayout from './layout/defaultLayout';

import { ConfigHandler } from './ConfigHandler';
import { ConfigData, SspAdData } from '@shared/types';
import logo from './assets/images/logo.png';

let xlr: IXlr;
let currentSspAd: SspAdData | null = null;

function generateSspXlf(ad: SspAdData): string {
  return '<?xml version="1.0"?>\n' +
    '<layout schemaVersion="1" width="' + ad.width + '" height="' + ad.height + '" bgcolor="#000000" background="">\n' +
    '\t<region id="axe" width="' + ad.width + '" height="' + ad.height + '" top="0" left="0">\n' +
    '\t\t<media id="axe" type="' + ad.xiboType + '" duration="' + ad.duration + '" lkid="1" schemaVersion="1">\n' +
    '\t\t\t<options>\n' +
    '\t\t\t\t<uri>' + ad.url + '</uri>\n' +
    '\t\t\t</options>\n' +
    '\t\t\t<raw/>\n' +
    '\t\t</media>\n' +
    '\t\t<options/>\n' +
    '\t</region>\n' +
    '</layout>\n';
}

if (window.__extendedConsole) {
  (globalThis as any).console = window.__extendedConsole;
}

console.alert('Loading renderer process . . .');

// Setup broadcast channel listeners
const bc = new BroadcastChannel('statsBC');

bc.addEventListener('message', (event) => {
  const eventData = event.data;
  console.debug('[Renderer::BroadcastChannel:statsBC] Received event', event);
  window.playerAPI.sendStatsBCMessage(eventData);
});

const faultsBC = new BroadcastChannel('player-faults-bc');

faultsBC.addEventListener('message', (event) => {
  const faultData = event.data;
  console.debug('[Renderer::BroadcastChannel:player-faults-bc] Received fault data', faultData);
  window.playerAPI.reportFault(faultData);
});

const runConfigHandler = async (config: ConfigData) => {
  const { callbackName } = await window.playerAPI.requestCallback();
  const mainCallback = async (...args) => {
    return await window.playerAPI.invokeCallback(callbackName, ...args);
  };

  // Show the configure view
  console.log('onConfigure: show configure view');
  const configHandler = new ConfigHandler(config, mainCallback);

  configHandler.init();

  // Run config
  await configHandler.run();
};

const initXlrEventHandlers = function () {
  xlr.on('sspWidgetRequest', async (media) => {
    console.debug('[XLR::on("sspWidgetRequest")] > Requesting SSP widget ad', {
      mediaId: media.id,
      partnerId: media.options.partnerid,
    });
    const adData = await window.apiHandler.sspGetWidgetAd(media.options.partnerid);
    if (adData) {
      media.setSspAdUrl(
        adData.url,
        adData.xiboType as 'image' | 'video',
        adData.impressionUrls,
        adData.errorUrls,
      );
    }
    // If null → no ad available; XLR will auto-skip via sspWidgetEnd([], [], 0)
  });

  xlr.on('sspWidgetEnd', async (impressionUrls, _errorUrls, duration) => {
    if (impressionUrls.length === 0) return;
    console.debug('[XLR::on("sspWidgetEnd")] > SSP widget played, reporting impression', {
      impressionUrls,
      duration,
    });
    await window.apiHandler.sspReportWidgetImpression(impressionUrls, duration);
  });

  xlr.on('adRequest', async (sspLayoutIndex: number) => {
    console.debug('[XLR::on("adRequest")] > Requesting SSP ad for slot', sspLayoutIndex);
    const adData = await window.apiHandler.sspGetAd();
    if (!adData) {
      console.warn('[RENDERER] [XLR::on("adRequest")] > No SSP ad available');
    }
    currentSspAd = adData;
    xlr.updateInputLayout(sspLayoutIndex, {
      ad: adData ?? null,
      duration: adData?.duration ?? 0,
      layoutId: -1,
      getXlf: () => adData ? generateSspXlf(adData) : '',
    } as InputLayoutType);
  });

  /**
   * Handles an incoming command identified by a CMS-provided command code.
   */
  xlr.on('commandCodeReceived', async (commandCode) => {
    console.log('[RENDERER] > [Xlr::commandCodeReceived] - Received a new command', commandCode);
    await window.apiHandler.executeXlrEvent('commandCodeReceived', { commandCode });
  });

  /**
   * Handles an incoming command provided as an encoded command string.
   */
  xlr.on('commandStringReceived', async (commandString) => {
    console.log('[RENDERER] > [Xlr::commandStringReceived] - Received a new command', commandString);
    await window.apiHandler.executeXlrEvent('commandStringReceived', { commandString });
  });


  xlr.on('layoutStart', async (layout) => {
    // When a layout starts playing, update CMS with the current layout
    // if "Notify current layout" is enabled.
    console.debug('[RENDERER] [XLR::on("layoutStart")] > Layout started', {
      layoutId: layout.layoutId,
    });

    // await window.apiHandler.sendCurrentLayoutAsStatusUpdate(layout.layoutId);
    await window.apiHandler.executeXlrEvent('layoutStart', { layoutId: layout.layoutId });
  });

  xlr.on('navLayout', async (layoutCode: string) => {
    const result = await window.apiHandler.findLayoutByCode(layoutCode);
    console.debug('[navLayout] [RENDERER] navLayout triggered', { layoutCode, foundLayoutId: result?.layoutId ?? null });

    if (!result) {
      console.warn('[navLayout] [RENDERER] Layout not found for code:', layoutCode);
      return;
    }

    await xlr.playInterruptLayout({
      layoutId: result.layoutId,
      path: result.name,
      response: null,
    });
  });

  xlr.on('layoutEnd', async (layout) => {
    // SSP impression reporting
    if (layout.layoutId === -1 && currentSspAd) {
      if (layout.state === ELayoutState.PLAYED && currentSspAd.impressionUrls.length > 0) {
        console.debug('[RENDERER] [XLR::on("layoutEnd")] > SSP ad played, reporting impression');
        await window.apiHandler.sspReportImpression(
          currentSspAd.impressionUrls,
          currentSspAd.duration,
          window.config?.state?.latitude ?? null,
          window.config?.state?.longitude ?? null,
        );
      }

      if (layout.state === ELayoutState.ERROR && currentSspAd.errorUrls.length > 0) {
        console.debug('[RENDERER] [XLR::on("layoutEnd")] > SSP ad error, reporting error');
        await window.apiHandler.sspReportError(
          currentSspAd.errorUrls,
          layout.errorCode ?? 405,
        );
      }
      currentSspAd = null;
    }

    if (layout.state !== ELayoutState.PLAYED) return;
    console.debug('[RENDERER] [XLR::on("layoutEnd")] > Layout ended', {
      scheduleId: layout.scheduleId,
    });
    await window.apiHandler.executeXlrEvent('layoutEnd', { scheduleId: layout.scheduleId });
  });

  xlr.on('overlayEnd', async (overlay) => {
    if (overlay.state !== ELayoutState.PLAYED) return;
    console.debug('[RENDERER] [XLR::on("overlayEnd")] > Overlay ended', {
      scheduleId: overlay.scheduleId,
    });
    await window.apiHandler.executeXlrEvent('overlayEnd', { scheduleId: overlay.scheduleId });
  });

}

export const startApp = async () => {
  const config = await window.apiHandler.getConfig();

  const xlrOptions: Partial<OptionsType> = {
    appHost: 'http://localhost:9696/files/',
    platform: ConsumerPlatform.ELECTRON, // TODO: XLR should support "electron" as a type (as well as webOS, Tizen, etc)
    config: {
      cmsUrl: config.cmsUrl ?? window.location.origin,
      cmsKey: config.cmsKey ?? '',
      schemaVersion: config.xmdsVersion as number,
      hardwareKey: config.hardwareKey as string,
    },
    icons: {
      splashScreen: logo,
      logo: logo,
    },
  };

  // Create a splash screen
  const splash = new DefaultLayout();
  splash.path = '0.xlf';

  let layoutLoop = [splash];

  xlr = XiboLayoutRenderer(layoutLoop, [], xlrOptions as any);
  xlr.init().then(async (response: any) => {
    console.log('onConfigure: play schedules');
    console.log(response);

    initXlrEventHandlers();
    await xlr.playSchedules(response);
  });

  // Set global xlr for browser access
  window.xlr = xlr;
};

window.playerAPI.onConfigure(async (config: ConfigData) => {
  console.log('onConfigure');
  window.config = config;

  if (!config.cmsUrl) {
    runConfigHandler(config);
  } else {
    startApp();
  }
});

window.playerAPI.onStateChange((state) => {
  if ($('#status').is(':visible')) {
    $('#status').html(state);
  }
});

window.playerAPI.onUpdateLoop((layouts) => {
  console.debug('[window.playerAPI.onUpdateLoop]', { layouts });
  if (xlr) {
    console.debug('[window.playerAPI.onUpdateLoop] > Emitting updateLoop to XLR');
    xlr.emitter.emit('updateLoop', layouts);
  }
});

window.playerAPI.onUpdateUniqueLayouts(async layouts => {
  if (xlr) {
    console.debug('[Renderer::onUpdateUniqueLayouts]', { layouts });
    await xlr.updateScheduleLayouts(layouts);
  }
});

window.playerAPI.onUpdateOverlays(async overlays => {
  if (xlr) {
    console.debug('[Renderer::onUpdateOverlays]', { overlays });
    xlr.emitter.emit('updateOverlays', overlays);
  }
});

window.playerAPI.onShowStatusWindow((timeout) => {
  showStatusWindowFn(timeout);
});

let statusWindowHideTimer: ReturnType<typeof setTimeout> | null = null;

const showStatusWindowFn = (timeout: number) => {
  console.debug('[Renderer::onShowStatusWindow]', { timeout });

  // Cancel any in-flight hide timer so a second show doesn't cut off updates early.
  if (statusWindowHideTimer !== null) {
    clearTimeout(statusWindowHideTimer);
    statusWindowHideTimer = null;
  }

  window.playerAPI.notifyStatusWindowVisibility(true);
  $('#status').show();

  statusWindowHideTimer = setTimeout(() => {
    console.debug('[Renderer::onShowStatusWindow] Hiding status window after timeout of:', timeout + ' seconds');
    $('#status').hide();
    window.playerAPI.notifyStatusWindowVisibility(false);
    statusWindowHideTimer = null;
  }, timeout * 1000);
};

const init = async () => {
  const config = await window.apiHandler.loadConfig();
  console.debug('[RENDERER] init > config', config);
  window.config = config;

  const showStatusWindow = (event: KeyboardEvent) => {
    if (event.key.toLowerCase() === 'i') {
      // Ignore if the user is typing inside an input field
      const target = event.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }

      console.debug('[Renderer] showStatusWindow event triggered by keypress "i"');
      showStatusWindowFn(60); // Show for 60 seconds
    }
  };

  document.removeEventListener('keydown', showStatusWindow); // Ensure we don't add multiple listeners
  document.addEventListener('keydown', showStatusWindow);

  if (!config.isConfigured) {
    runConfigHandler(config);
  } else {
    const { callbackName } = await window.playerAPI.requestCallback();
    const mainCallback = async (...args) => {
      return await window.playerAPI.invokeCallback(callbackName, ...args);
    };

    // Run mainCallback
    await mainCallback({ context: 'renderer' });

    console.debug('[RENDERER] > startApp(): Called mainCallback');
    await startApp();
  }
};

init();
