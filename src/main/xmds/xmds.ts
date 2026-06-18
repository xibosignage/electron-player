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

import xml2js from 'xml2js';
import { Config } from "../config/config";
import axios, { AxiosError } from "axios";
import { createNanoEvents, Emitter } from 'nanoevents';

import { RegisterDisplay } from './response/registerDisplay';
import { ErrorCodes, handleError } from "./error/error";
import RequiredFiles from "./response/requiredFiles";
import Schedule from "./response/schedule/schedule";
import { LogsThreshold, RequiredFile } from '../common/types';
import { ConsoleDB } from '../../shared/console/ConsoleDB';
import { escapeStringForXml, submitLogsXmlString } from '../common/parser';
import { AxiosErrorCodes, handleXmdsError } from '../common/error/XmdsError';
import { commandManager } from '../../shared/command/commandManager';
import { StateData } from '../common/state';
import { GetWeather } from './response/getWeather';

interface XmdsEvents {
  collecting: () => void;
  collected: () => void;
  registered: (message: RegisterDisplay) => void;
  requiredFiles: (object: RequiredFiles) => void;
  schedule: (object: Schedule) => void;
  submitLogs: () => void;
  reportFaults: () => void;
  submitStats: () => void;
  weatherCriteriaUpdates: (object: Record<string, any>) => void;
}

export class Xmds {
  emitter: Emitter<XmdsEvents>;

  collectIntervalTime: number = 300;
  interval: NodeJS.Timeout | undefined;
  logsInterval: NodeJS.Timeout | undefined;
  hasSubmittedLogs: boolean | null = null;
  getWeatherData: boolean = false;

  private static rateLimitTracker: Map<string, number> = new Map();
  private static pendingRetries: Set<string> = new Set();

  // CRC32
  checkRf: string | null = null;
  checkSchedule: string | null = null;

  constructor(private config: Config) {
    // Emitter
    this.emitter = createNanoEvents<XmdsEvents>();
  }

  on<E extends keyof XmdsEvents>(event: E, callback: XmdsEvents[E]) {
    return this.emitter.on(event, callback);
  }

  async getSchemaVersion() {
    // Do we already have the schema version?
    if (!this.config.xmdsVersion || this.config.xmdsVersion <= 0) {
      this.config.xmdsVersion = await axios.get(this.config.cmsUrl + '/xmds.php?what')
        .then(function (response) {
          // handle success
          return parseInt(response?.data || -1);
        })
        .catch(function () {
          return -1;
        });
    }

    return this.config.xmdsVersion;
  };

  async start(intervalTime: number) {
    this.collectIntervalTime = intervalTime;

    await this.startInterval();

    await this.collect(this.checkRf, this.checkSchedule);
  }

  async startInterval() {
    console.debug('[Xmds::startInterval] Starting XMDS collection interval');

    if (this.interval !== undefined) {
      clearInterval(this.interval);
    }

    // checkRf/checkSchedule are the values we obtained the last time this ran.
    this.interval = setInterval(async () => {
      // Regular collection.
      await this.collect(this.checkRf, this.checkSchedule);
    }, this.collectIntervalTime * 1000);
  }

  async updateInterval(intervalTime: number) {
    const isValidIntervalTime = !isNaN(intervalTime * 1000);

    if (isValidIntervalTime && intervalTime !== this.collectIntervalTime) {
      console.debug('[Xmds::updateInterval] Updating XMDS collection interval to ' + intervalTime + ' seconds');
      this.collectIntervalTime = intervalTime;
      await this.startInterval();
    }
  }

  async collectNow() {
    await this.collect(this.checkRf, this.checkSchedule);
  }

  async collect(checkRf: string | null, checkSchedule: string | null) {
    this.emitter.emit('collecting');
    try {
      await this.registerDisplay();
    } catch (error) {
      console.error('[Xmds::collect::registerDisplay] Error', {
        error: error,
        shouldParse: false,
      });
      const err = handleError(error, 'Unable to register with the CMS.');
      console.log('XMDS::collect', err);

      if (err.message === ErrorCodes.NotAuthorisedMsg) {
        return;
      }
    }

    if (this.config.state.displayStatus === 0) {
      console.log('Display state is 0, checking requried files and schedule');

      this.emitter.emit('submitLogs');

      await this.requiredFiles(checkRf ?? '');
      await this.schedule(checkSchedule ?? '');

      console.debug('[Xmds::collect] Checking if stats are enabled', { statsEnabled: this.config.settings.statsEnabled });
      // Check if stats are enabled
      if (Boolean(this.config.settings.statsEnabled)) {
        this.emitter.emit('submitStats');
      }

      await this.notifyStatus();

      this.emitter.emit('reportFaults');
    }

    // Fetch weather criteria update if enabled
    if (this.getWeatherData) {
      await this.getWeather();
    }

    this.emitter.emit('collected');
  }

  /**
   * Returns true if the given method is still rate limited.
   *
   * @param method
   * @private
   */
  private isRateLimited(method: string): boolean {
    const retryAt = Xmds.rateLimitTracker.get(method);
    if (!retryAt) return false;

    if (Date.now() >= retryAt) {
      // expired, cleanup
      Xmds.rateLimitTracker.delete(method);
      return false;
    }

    return true;
  }

  /**
   * Sets a rate limit cooldown for a method using the Retry-After header if available,
   * otherwise falls back to a default value. Optionally retries the method after the delay.
   *
   * @param method The XMDS method name (e.g. 'registerDisplay')
   * @param retryAfterHeader
   * @param retryFn Optional function to retry once the cooldown expires
   * @private
   */
  private setRateLimit(
      method: string,
      retryAfterHeader?: string,
      retryFn?: () => void
  ) {
    // Default to 5 minutes delay
    let retryAfterSeconds = 300;

    if (retryAfterHeader) {
      const parsed = parseInt(retryAfterHeader);

      // Use server-provided delay if present
      if (!isNaN(parsed)) {
        retryAfterSeconds = parsed;
      }
    }

    const retry = retryAfterSeconds * 1000;
    const retryAt = Date.now() + retry;

    console.debug(`[Xmds::setRateLimit] ${method} blocked until`, new Date(retryAt).toISOString());

    // Store when the method is allowed to run again
    Xmds.rateLimitTracker.set(method, retryAt);

    if (retryFn && !Xmds.pendingRetries.has(method)) {
      Xmds.pendingRetries.add(method);
      setTimeout(() => {
        Xmds.pendingRetries.delete(method);
        console.debug(`[Xmds::setRateLimit] retrying ${method}`);

        // Run the method after cooldown
        retryFn();
      }, retry);
    }
  }

  async registerDisplay(forceScheduleUpdate: boolean = false) {
    const method = 'registerDisplay';

    // Skip request if method was recently rate limited (429)
    if (this.isRateLimited(method)) {
      console.debug('[Xmds::registerDisplay] skipped due to rate limit');
      return;
    }

    const soapXml = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:tns="urn:xmds" xmlns:types="urn:xmds/encodedTypes" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
      '  <soap:Body soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n' +
      '    <tns:RegisterDisplay>\n' +
      '      <serverKey xsi:type="xsd:string"><![CDATA[' + this.config.cmsKey + ']]></serverKey>\n' +
      '      <hardwareKey xsi:type="xsd:string">' + this.config.hardwareKey + '</hardwareKey>\n' +
      '      <displayName xsi:type="xsd:string"><![CDATA[' + this.config.displayName + ']]></displayName>\n' +
      '      <clientType xsi:type="xsd:string">' + this.config.getXmdsPlayerType() + '</clientType>\n' +
      '      <clientVersion xsi:type="xsd:string">' + this.config.version + '</clientVersion>\n' +
      '      <clientCode xsi:type="xsd:int">' + this.config.versionCode + '</clientCode>\n' +
      '      <macAddress xsi:type="xsd:string">' + this.config.macAddress + '</macAddress>\n' +
      '      <xmrChannel xsi:type="xsd:string">' + this.config.xmrChannel + '</xmrChannel>\n' +
      '      <operatingSystem xsi:type="xsd:string">' + JSON.stringify(this.config.platform) + '</operatingSystem>\n' +
      '      <licenceResult xsi:type="xsd:string"></licenceResult>\n' +
      '    </tns:RegisterDisplay>\n' +
      '  </soap:Body>\n' +
      '</soap:Envelope>';

    return await axios.post(
      this.config.cmsUrl + '/xmds.php?v=' + this.config.xmdsVersion + '&method=registerDisplay',
      soapXml,
      {
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
        },
        responseType: 'text',
        transformResponse: r => r,
        validateStatus: () => true,
      }
    ).then(async ({ data, status, headers }) => {
      if (status === 200) {
        // Parse out the checkRf/checkSchedule values and store them.
        const registerDisplay = new RegisterDisplay(data);
        await registerDisplay.parse();
        if (!forceScheduleUpdate) {
          this.checkSchedule = registerDisplay.checkSchedule || null;
          this.checkRf = registerDisplay.checkRf || null;
        }

        // Parse out the list of commands and store them in the command manager.
        const commands = registerDisplay.getCommands();
        console.debug('[Xmds::registerDisplay] Commands received from CMS', { commands });
        commandManager.parseCommands(commands);

        // Update the collection interval as necessary
        await this.updateInterval(registerDisplay.getSetting('collectInterval', 300) as number);

        // Save config
        await this.config.save();
        await this.config.saveCms();

        console.debug('Display registered', {
          method: 'XMDS::registerDisplay',
          checkSchedule: registerDisplay.checkSchedule,
          checkRf: registerDisplay.checkRf,
        });
        // Emit
        this.emitter.emit('registered', registerDisplay);
      } else if (status === 429) {
        this.setRateLimit(method, headers['retry-after'] as string | undefined, () => this.registerDisplay(true));
      } else if (status >= 400) {
        throw await handleXmdsError(data);
      }
    }).catch(error => {
      if (error instanceof AxiosError) {
        if (error.code === AxiosErrorCodes.ECONNREFUSED) {
          throw new Error('Unable to connect to the given CMS Address. Please check your connection and try again.');
        } else {
          throw {
            code: error.code,
            message: error.message,
          }
        }
      } else {
        throw error;
      }
    });
  }

  async requiredFiles(crc32: string) {
      if (crc32 == null || crc32 != this.checkRf) {
      const method = 'requiredFiles';

      if (this.isRateLimited(method)) {
        console.debug('[Xmds::requiredFiles] skipped due to rate limit');
        return;
      }

      // Make a new request.
      const soapXml = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:tns="urn:xmds" xmlns:types="urn:xmds/encodedTypes" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
        '  <soap:Body soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n' +
        '    <tns:RequiredFiles>\n' +
        '      <serverKey xsi:type="xsd:string"><![CDATA[' + this.config.cmsKey + ']]></serverKey>\n' +
        '      <hardwareKey xsi:type="xsd:string">' + this.config.hardwareKey + '</hardwareKey>\n' +
        '    </tns:RequiredFiles>\n' +
        '  </soap:Body>\n' +
        '</soap:Envelope>';
      await axios.post(
        this.config.cmsUrl + '/xmds.php?v=' + this.config.xmdsVersion + '&method=requiredFiles',
        soapXml)
        .then(async (response) => {
          const requiredFiles = new RequiredFiles(response.data);
          await requiredFiles.parse();

          console.debug('XMDS RequiredFiles fetched', {
            method: 'XMDS::requiredFiles',
          });

          this.emitter.emit('requiredFiles', requiredFiles);
        })
        .catch((error: AxiosError) => {
          if (error.response?.status === 429) {
            // Handle 429 by setting cooldown and retrying this method later
            this.setRateLimit(
                method,
                error.response.headers?.['retry-after'],
                () => this.requiredFiles(crc32)
            );
          }

          return handleError(error);
        });
    }
  }

  async mediaInventory(files: string) {
    const method = 'mediaInventory';

    // Skip request if method was recently rate limited (429)
    if (this.isRateLimited(method)) {
        console.debug('[Xmds::mediaInventory] skipped due to rate limit');
      return;
    }

    const soapXml = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:tns="urn:xmds" xmlns:types="urn:xmds/encodedTypes" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
      ' <soap:Body soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n' +
      '   <tns:MediaInventory>\n' +
      '     <serverKey xsi:type="xsd:string"><![CDATA[' + this.config.cmsKey + ']]></serverKey>\n' +
      '     <hardwareKey xsi:type="xsd:string">' + this.config.hardwareKey + '</hardwareKey>\n' +
      '     <mediaInventory xsi:type-="xsd:string">&lt;files&gt;' + files + '&lt;/files&gt;</mediaInventory>\n' +
      '   </tns:MediaInventory>\n' +
      ' </soap:Body>\n' +
      '</soap:Envelope>';

    return await axios.post(
      this.config.cmsUrl + '/xmds.php?v=' + this.config.xmdsVersion + '&method=mediaInventory',
      soapXml
    )
    .catch((error: AxiosError) => {
      if (error.response?.status === 429) {
        // Handle 429 by setting cooldown and retrying this method later
        this.setRateLimit(
            method,
            error.response.headers?.['retry-after'],
            () => this.mediaInventory(files)
        );
      }

      return handleError(error);
    });
  }

  async submitMediaInventory(mediaInventory: { xmlString: string; files: RequiredFile[] }) {
    if (mediaInventory.xmlString.length > 0) {
      // Report current state of files
      await this.mediaInventory(mediaInventory.xmlString);
    }

    return mediaInventory.files;
  }

  async schedule(crc32: string) {
    const method = 'schedule';

    // Skip request if method was recently rate limited (429)
    if (this.isRateLimited(method)) {
      console.debug('[Xmds::schedule] skipped due to rate limit');
      return;
    }

    if (crc32 == null || crc32 != this.checkSchedule) {
      // Make a new request.
      const soapXml = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:tns="urn:xmds" xmlns:types="urn:xmds/encodedTypes" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
        '  <soap:Body soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n' +
        '    <tns:Schedule>\n' +
        '      <serverKey xsi:type="xsd:string"><![CDATA[' + this.config.cmsKey + ']]></serverKey>\n' +
        '      <hardwareKey xsi:type="xsd:string">' + this.config.hardwareKey + '</hardwareKey>\n' +
        '    </tns:Schedule>\n' +
        '  </soap:Body>\n' +
        '</soap:Envelope>';
      return await axios.post(
        this.config.cmsUrl + '/xmds.php?v=' + this.config.xmdsVersion + '&method=schedule',
        soapXml,)
        .then(async (response) => {
          const playerSchedule = new Schedule(response.data);
          await playerSchedule.parse();

          console.debug('XMDS Schedule fetched', {
            method: 'XMDS::schedule',
          });

          this.emitter.emit('schedule', playerSchedule);
        })
        .catch((error: AxiosError) => {
          if (error.response?.status === 429) {
            // Handle 429 by setting cooldown and retrying this method later
            this.setRateLimit(
                method,
                error.response.headers?.['retry-after'],
                () => this.schedule(crc32)
            );
          }

          return handleError(error);
        });
    }
  }

  async screenshot(screenshot: string | null) {
    const method = 'screenshot';

    // Skip request if method was recently rate limited (429)
    if (this.isRateLimited(method)) {
      console.debug('[Xmds::screenshot] skipped due to rate limit');
      return;
    }
    
    if (screenshot === null) {
      console.debug('[Xmds::screenshot] No screenshot to submit');
      return;
    }

    // It is not possible to get screenshots from ChromeOS, but we need a screenshot to access notify status
    // and, it is a useful way to get "proof of life".
    const soapXml = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:tns="urn:xmds" xmlns:types="urn:xmds/encodedTypes" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
      ' <soap:Body soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n' +
      '   <tns:SubmitScreenShot>\n' +
      '     <serverKey xsi:type="xsd:string"><![CDATA[' + this.config.cmsKey + ']]></serverKey>\n' +
      '     <hardwareKey xsi:type="xsd:string">' + this.config.hardwareKey + '</hardwareKey>\n' +
      '     <screenShot xsi:type-="xsd:base64Binary">' + screenshot + '</screenShot>\n' +
      '   </tns:SubmitScreenShot>\n' +
      ' </soap:Body>\n' +
      '</soap:Envelope>';

    return await axios.post(
      this.config.cmsUrl + '/xmds.php?v=' + this.config.xmdsVersion + '&method=',
      soapXml
    )
    .catch((error: AxiosError) => {
      if (error.response?.status === 429) {
        // Handle 429 by setting cooldown and retrying this method later
        this.setRateLimit(
            method,
            error.response.headers?.['retry-after'],
            () => this.screenshot(screenshot)
        );
      }

      return handleError(error);
    });
  }

  async handleSubmitLogs(db: ConsoleDB) {
    const method = 'handleSubmitLogs';

    // Skip request if method was recently rate limited (429)
    if (this.isRateLimited(method)) {
      console.debug('[Xmds::handleSubmitLogs] skipped due to rate limit');
      return;
    }

    const logLevel = this.config.getSetting('logLevel', 'error');
    const logLevelCategory = logLevel.charAt(0).toUpperCase() + logLevel.slice(1);
    const logs = db.getLogsExcludingFaults(LogsThreshold);

    console.debug('[Xmds::handleSubmitLogs] Handling log submission', {
      logsCount: logs.length,
      logLevelCategory,
      logLevel,
    });

    this.hasSubmittedLogs = false;

    if (logs.length === 0) {
      console.debug('[Xmds::handleSubmitLogs] > No logs to submit, clearing interval');

      if (this.logsInterval !== undefined) {
        this.hasSubmittedLogs = null;
        clearInterval(this.logsInterval);
        this.logsInterval = undefined;
      }

      return;
    }

    // clear logsInterval when logs count < LogsThreshold
    if (logs.length < LogsThreshold && this.logsInterval !== undefined) {
      this.hasSubmittedLogs = null;
      clearInterval(this.logsInterval);
      this.logsInterval = undefined;
    }

    let logsXmlStr = '';

    logs.forEach((log) => logsXmlStr += submitLogsXmlString(log));

    const soapXml = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:tns="urn:xmds" xmlns:types="urn:xmds/encodedTypes" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
      ' <soap:Body soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n' +
      '   <tns:SubmitLog>\n' +
      '     <serverKey xsi:type="xsd:string"><![CDATA[' + this.config.cmsKey + ']]></serverKey>\n' +
      '     <hardwareKey xsi:type="xsd:string">' + this.config.hardwareKey + '</hardwareKey>\n' +
      '     <logXml xsi:type="xsd:string">&lt;logs&gt;' + logsXmlStr + '&lt;/logs&gt;</logXml>\n' +
      '   </tns:SubmitLog>\n' +
      ' </soap:Body>\n' +
      '</soap:Envelope>';

    await axios.post(
      this.config.cmsUrl + '/xmds.php?v=' + this.config.xmdsVersion + '&method=submitLog',
      soapXml
    )
      .then(async response => {
        const parser = new xml2js.Parser();
        const rootDoc = await parser.parseStringPromise(response.data);

        // Get the encoded XML
        const result = rootDoc["SOAP-ENV:Envelope"]["SOAP-ENV:Body"][0]["ns1:SubmitLogResponse"][0].success[0]._;

        console.debug('[Xmds::submitLogs] Logs submitted to CMS');
        // If response succeeded, then delete pushed logs
        if (result === 'true') {
          console.log('Log start with uid: ' + logs[0].uid);
          console.log('Deleting pushed logs, count = ' + logs.length);

          db.deleteLogs(logs);

          console.log('Deleted pushed logs');

          this.hasSubmittedLogs = true;
        }
      })
      .catch((error: AxiosError) => {
        if (error.response?.status === 429) {
          // Handle 429 by setting cooldown and retrying this method later
          this.setRateLimit(
              method,
              error.response.headers?.['retry-after'],
              () => this.handleSubmitLogs(db)
          );
        }

        return handleError(error, 'Unable to submit logs');
      });
  }

  async submitLogs(db: ConsoleDB) {
    console.debug('[Xmds::submitLogs] Submitting Logs to CMS');
    const logLevel = this.config.getSetting('logLevel', 'error');
    const logLevelCategory = logLevel.charAt(0).toUpperCase() + logLevel.slice(1);

    if (logLevelCategory === 'Off') {
      console.debug('[Xmds::submitLogs] > Log level is off, skipping log submission');
    }

    const logsCount = db.count();

    if (logsCount > LogsThreshold) {
      const batchInterval = 10; // 10 seconds interval for batch submission

      // Clear any existing interval before starting a new one.
      if (this.logsInterval !== undefined) {
        clearInterval(this.logsInterval);
        this.logsInterval = undefined;
      }

      // then submit backlog of logs in batch of LogsThreshold
      this.logsInterval = setInterval(async () => {
        if (this.hasSubmittedLogs || this.hasSubmittedLogs === null) {
          await this.handleSubmitLogs(db);
        }
      }, batchInterval * 1000);
    } else {
      if (this.logsInterval !== undefined) {
        clearInterval(this.logsInterval);
        this.logsInterval = undefined;
      }

      await this.handleSubmitLogs(db);
    }
  }

  async submitStats(statsXmlString: string) {
    const method = 'submitStats';

    // Skip request if method was recently rate limited (429)
    if (this.isRateLimited(method)) {
      console.debug('[Xmds::submitStats] skipped due to rate limit');
      return;
    }

    // Make a new request.
    const soapXml = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:tns="urn:xmds" xmlns:types="urn:xmds/encodedTypes" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
      '  <soap:Body soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n' +
      '    <tns:SubmitStats>\n' +
      '      <serverKey xsi:type="xsd:string"><![CDATA[' + this.config.cmsKey + ']]></serverKey>\n' +
      '      <hardwareKey xsi:type="xsd:string">' + this.config.hardwareKey + '</hardwareKey>\n' +
      '      <statXml xsi:type="xsd:string">&lt;records&gt;' + statsXmlString + '&lt;/records&gt;</statXml>\n' +
      '    </tns:SubmitStats>\n' +
      '  </soap:Body>\n' +
      '</soap:Envelope>';

    return await axios.post(
      this.config.cmsUrl + '/xmds.php?v=' + this.config.xmdsVersion + '&method=submitStat',
      soapXml,)
      .then(async response => {
        const parser = new xml2js.Parser();
        const rootDoc = await parser.parseStringPromise(response.data);

        // Get the encoded XML
        const result = rootDoc["SOAP-ENV:Envelope"]["SOAP-ENV:Body"][0]["ns1:SubmitStatsResponse"][0].success[0]._;

        return result === 'true';
      })
      .catch((error: AxiosError) => {
        if (error.response?.status === 429) {
          // Handle 429 by setting cooldown and retrying this method later
          this.setRateLimit(
              method,
              error.response.headers?.['retry-after'],
              () => this.submitStats(statsXmlString)
          );
        }

        return handleError(error);
      });
  }

  async notifyStatus(keys?: Partial<(keyof StateData)[]>) {
    const method = 'notifyStatus';

    // Skip request if method was recently rate limited (429)
    if (this.isRateLimited(method)) {
      console.debug('[Xmds::notifyStatus] skipped due to rate limit');
      return;
    }

    const soapXml = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:tns="urn:xmds" xmlns:types="urn:xmds/encodedTypes" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
      ' <soap:Body soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n' +
      '   <tns:NotifyStatus>\n' +
      '     <serverKey xsi:type="xsd:string"><![CDATA[' + this.config.cmsKey + ']]></serverKey>\n' +
      '     <hardwareKey xsi:type="xsd:string">' + this.config.hardwareKey + '</hardwareKey>\n' +
      '     <status xsi:type-="xsd:string">' + this.config.state.toJson(keys) + '</status>\n' +
      '   </tns:NotifyStatus>\n' +
      ' </soap:Body>\n' +
      '</soap:Envelope>';

      return await axios.post(
        this.config.cmsUrl + '/xmds.php?v=' + this.config.xmdsVersion + '&method=notifyStatus',
        soapXml
      )
      .catch((error: AxiosError) => {
        if (error.response?.status === 429) {
          // Handle 429 by setting cooldown and retrying this method later
          this.setRateLimit(
              method,
              error.response.headers?.['retry-after'],
              () => this.notifyStatus(keys)
          );
        }

        return handleError(error);
      });
  }

  /**
   * Requests the latest weather criteria from the CMS.
   * Triggers a `weatherCriteriaUpdates` event once new data is received.
   */
  async getWeather() {
    const method = 'getWeather';

    // Skip request if method was recently rate limited (429)
    if (this.isRateLimited(method)) {
      console.debug('[Xmds::getWeather] skipped due to rate limit');
      return;
    }

    const soapXml = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:tns="urn:xmds" xmlns:types="urn:xmds/encodedTypes" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
      ' <soap:Body soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n' +
      '   <tns:GetWeather>\n' +
      '     <serverKey xsi:type="xsd:string"><![CDATA[' + this.config.cmsKey + ']]></serverKey>\n' +
      '     <hardwareKey xsi:type="xsd:string">' + this.config.hardwareKey + '</hardwareKey>\n' +
      '   </tns:GetWeather>\n' +
      ' </soap:Body>\n' +
      '</soap:Envelope>';

    try {
      const response = await axios.post(this.config.cmsUrl + '/xmds.php?v=' + this.config.xmdsVersion, soapXml);

      // Parse response into the GetWeather object
      const weatherCriteria = new GetWeather(response.data);
      await weatherCriteria.parse();

      // Emit the weatherCriteriaUpdates event and pass the parsed weather data
      this.emitter.emit('weatherCriteriaUpdates', weatherCriteria.data);
      return weatherCriteria;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 429) {
          // Handle 429 by setting cooldown and retrying this method later
          this.setRateLimit(
              method,
              error.response.headers?.['retry-after'],
              () => this.getWeather()
          );
        }
      }

      return handleError(error);
    }
  }

  async reportFaults(faults: string) {
    const method = 'reportFaults';

    // Skip request if method was recently rate limited (429)
    if (this.isRateLimited(method)) {
      console.debug('[Xmds::reportFaults] skipped due to rate limit');
      return;
    }

    console.debug('[Xmds::reportFaults] Reporting Faults to CMS');
    
    const soapXml = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:tns="urn:xmds" xmlns:types="urn:xmds/encodedTypes" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
        ' <soap:Body soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n' +
        '   <tns:ReportFaults>\n' +
        '     <serverKey xsi:type="xsd:string"><![CDATA[' + this.config.cmsKey + ']]></serverKey>\n' +
        '     <hardwareKey xsi:type="xsd:string">' + this.config.hardwareKey + '</hardwareKey>\n' +
        '     <fault xsi:type-="xsd:string">' + escapeStringForXml(faults) + '</fault>\n' +
        '   </tns:ReportFaults>\n' +
        ' </soap:Body>\n' +
        '</soap:Envelope>';

    return await axios.post(
      this.config.cmsUrl + '/xmds.php?v=' + this.config.xmdsVersion + '&method=reportFaults',
      soapXml
    )
    .catch((error: AxiosError) => {
      if (error.response?.status === 429) {
        // Handle 429 by setting cooldown and retrying this method later
        this.setRateLimit(
            method,
            error.response.headers?.['retry-after'],
            () => this.reportFaults(faults)
        );
      }

      return handleError(error);
    });
  }

  async getResource(file: RequiredFile) {
    const method = 'getResource';

    // Skip request if method was recently rate limited (429)
    if (this.isRateLimited(method)) {
      console.debug('[Xmds::getResource] skipped due to rate limit');
      return;
    }

    try {
      const soapXml = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:tns="urn:xmds" xmlns:types="urn:xmds/encodedTypes" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
        ' <soap:Body soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n' +
        '   <tns:GetResource>\n' +
        '     <serverKey xsi:type="xsd:string"><![CDATA[' + this.config.cmsKey + ']]></serverKey>\n' +
        '     <hardwareKey xsi:type="xsd:string">' + this.config.hardwareKey + '</hardwareKey>\n' +
        '     <layoutId xsi:type="xsd:string">' + file.layoutId + '</layoutId>\n' +
        '     <regionId xsi:type="xsd:string">' + file.regionId + '</regionId>\n' +
        '     <mediaId xsi:type="xsd:string">' + file.mediaId + '</mediaId>\n' +
        '   </tns:GetResource>\n' +
        ' </soap:Body>\n' +
        '</soap:Envelope>';

      return await axios.post(
        this.config.cmsUrl + '/xmds.php?v=' + this.config.xmdsVersion + '&method=getResource',
        soapXml
      )
        .then(async (response) => {
          const parser = new xml2js.Parser();
          const rootDoc = await parser.parseStringPromise(response.data);

          // Get the encoded XML
          const xml = rootDoc["SOAP-ENV:Envelope"]["SOAP-ENV:Body"][0]["ns1:GetResourceResponse"][0].resource[0]._;

          return xml;
        })
        .catch((error: AxiosError) => {
          console.error('[Xmds::getResource] > Error fetching resource XML: ', {
            error,
          });

          if (error.response?.status === 429) {
            // Handle 429 by setting cooldown and retrying this method later
            this.setRateLimit(
                method,
                error.response.headers?.['retry-after'],
                () => this.getResource(file)
            );
          }

          handleError(error)
        });
    } catch (e) {
      console.error('[Xmds::getResource] > Error fetching resource XML: ', {
        e,
      });

      handleError(e);
    }
  }
  
  async getData(widgetId: RequiredFile['id']) {
    const method = 'getData';

    // Skip request if method was recently rate limited (429)
    if (this.isRateLimited(method)) {
      console.debug('[Xmds::getData] skipped due to rate limit');
      return;
    }

    try {
      const soapXml = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:tns="urn:xmds" xmlns:types="urn:xmds/encodedTypes" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
        ' <soap:Body soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n' +
        '   <tns:GetData>\n' +
        '     <serverKey xsi:type="xsd:string"><![CDATA[' + this.config.cmsKey + ']]></serverKey>\n' +
        '     <hardwareKey xsi:type="xsd:string">' + this.config.hardwareKey + '</hardwareKey>\n' +
        '     <widgetId xsi:type="xsd:string">' + widgetId + '</widgetId>\n' +
        '   </tns:GetData>\n' +
        ' </soap:Body>\n' +
        '</soap:Envelope>';

      return await axios.post(
        this.config.cmsUrl + '/xmds.php?v=' + this.config.xmdsVersion + '&method=getData',
        soapXml
      )
        .then(async (response) => {
          const parser = new xml2js.Parser();
          const rootDoc = await parser.parseStringPromise(response.data);

          // Get the encoded XML
          const xml = rootDoc["SOAP-ENV:Envelope"]["SOAP-ENV:Body"][0]["ns1:GetDataResponse"][0].data[0]._;

          return xml;
        })
        .catch((error: AxiosError) => {
          console.error('[Xmds::getData] > Error fetching data XML: ', {
            error,
          });

          if (error.response?.status === 429) {
            // Handle 429 by setting cooldown and retrying this method later
            this.setRateLimit(
                method,
                error.response.headers?.['retry-after'],
                () => this.getData(widgetId)
            );
          }

          handleError(error, 'Unable to fetch data for widget with id ' + widgetId);

          return false;
        });
    } catch (e) {
      console.error('[Xmds::getData] > Error fetching data XML: ', {
        e,
      });

      handleError(e, 'Unable to fetch data for widget with id ' + widgetId);

      return false;
    }
  }
  
  /**
   * Enables or disables automatic weather criteria fetching.
   *
   * @param value boolean
   */
  setGetWeatherData(value: boolean) {
    this.getWeatherData = value;
  }
}
