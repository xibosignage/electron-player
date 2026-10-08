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
import { LogsMaxStored, LogsThreshold, RequiredFile } from '../common/types';
import { ConsoleDB } from '../../shared/console/ConsoleDB';
import { escapeStringForXml, submitLogsXmlString } from '../common/parser';
import { hasUndownloadedFiles } from '../common/fileManager';
import { AxiosErrorCodes, describeRequestFailure, handleXmdsError } from '../common/error/XmdsError';
import { commandManager } from '../../shared/command/commandManager';
import { StateData } from '../common/state';
import { GetWeather } from './response/getWeather';

// How long an XMDS request may go without receiving any data before it is abandoned. This is
// an idle timeout, not a limit on the whole request, so a large response that keeps arriving
// is never cut off. Without it a connection the CMS never answers holds a collection forever.
const XMDS_TIMEOUT_MS = 120 * 1000;

// The result of a CMS fetch.
// rateLimited means the CMS asked us to wait, which is not the same as a failure.
export type XmdsFetch<T> =
  | { ok: true; data: T }
  | { ok: false; rateLimited: boolean };

interface XmdsEvents {
  collecting: () => void;
  collected: () => void;
  registered: (message: RegisterDisplay) => void;
  requiredFiles: (object: RequiredFiles, verifyLocalFiles: boolean) => void;
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
  // True while a batch of logs is being submitted.
  private logsSubmitting = false;
  getWeatherData: boolean = false;

  private static rateLimitTracker: Map<string, number> = new Map();
  private static pendingRetries: Set<string> = new Set();

  // The checksums the CMS reported at the last registration.
  cmsCheckRf: string | null = null;
  cmsCheckSchedule: string | null = null;

  // The checksums of the file list and schedule last fetched successfully. Setting one to
  // null makes the next collection fetch it again.
  checkRf: string | null = null;
  checkSchedule: string | null = null;

  // The collection in progress, and whether another was asked for while it ran.
  private collection: Promise<void> | null = null;
  private collectAgain = false;

  private schemaVersionError: string | null = null;

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
      this.schemaVersionError = null;

      this.config.xmdsVersion = await axios.get(this.config.cmsUrl + '/xmds.php?what', { timeout: XMDS_TIMEOUT_MS })
        .then(function (response) {
          // handle success
          return parseInt(response?.data || -1);
        })
        .catch((error) => {
          this.schemaVersionError = describeRequestFailure(error);

          console.error('[Xmds::getSchemaVersion] Could not read the XMDS version', {
            cmsUrl: this.config.cmsUrl,
            code: error?.code,
            status: error?.response?.status,
            message: error?.message,
          });

          return -1;
        });
    }

    return this.config.xmdsVersion;
  };

  // Returns why the last getSchemaVersion() call failed, or null if it succeeded.
  getSchemaVersionError() {
    return this.schemaVersionError;
  }

  async start(intervalTime: number) {
    this.collectIntervalTime = intervalTime;

    await this.startInterval();

    await this.collect();
  }

  async startInterval() {
    console.debug('[Xmds::startInterval] Starting XMDS collection interval');

    if (this.interval !== undefined) {
      clearInterval(this.interval);
    }

    this.interval = setInterval(async () => {
      // Regular collection.
      await this.collect();
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
    await this.collect();
  }

  /**
   * Runs a collection, unless one is already running.
   *
   * The interval, XMR and other callers can all ask at once. Running collections on top of
   * each other would submit the same stats and logs twice, so a request that arrives during
   * a collection runs one more collection after it instead. The promise resolves once the
   * collections that were asked for have finished.
   */
  collect(): Promise<void> {
    if (this.collection) {
      this.collectAgain = true;
      return this.collection;
    }

    this.collection = (async () => {
      try {
        do {
          this.collectAgain = false;

          try {
            await this.collectOnce();
          } catch (error) {
            console.error('[Xmds::collect] Collection failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } while (this.collectAgain);
      } finally {
        this.collection = null;
      }
    })();

    return this.collection;
  }

  private async collectOnce() {
    this.emitter.emit('collecting');
    try {
      await this.registerDisplay();
    } catch (error) {
      // Errors are logged as summaries, so the details can go to the CMS log too
      console.error('[Xmds::collect::registerDisplay] Error', { error });
      const err = handleError(error, 'Unable to register with the CMS.');
      console.log('XMDS::collect', err);

      if (err.message === ErrorCodes.NotAuthorisedMsg) {
        return;
      }
    }

    if (this.config.state.displayStatus === 0) {
      console.log('Display state is 0, checking requried files and schedule');

      this.emitter.emit('submitLogs');

      await this.requiredFiles();
      await this.schedule();

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
   * Clears all rate-limit cooldowns and pending retries. The rate limit tracker is keyed only
   * by method name (not by CMS), so a cooldown set against one CMS would otherwise silently
   * block the same method against a different CMS after a transfer.
   */
  clearRateLimits() {
    Xmds.rateLimitTracker.clear();
    Xmds.pendingRetries.clear();
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
        timeout: XMDS_TIMEOUT_MS,
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
        },
        responseType: 'text',
        transformResponse: r => r,
        validateStatus: () => true,
      }
    ).then(async ({ data, status, headers }) => {
      if (status === 200) {
        // Store the checksums the CMS reports. requiredFiles() and schedule() compare them
        // with the ones last fetched successfully.
        const registerDisplay = new RegisterDisplay(data);
        await registerDisplay.parse();
        if (!forceScheduleUpdate) {
          this.cmsCheckSchedule = registerDisplay.checkSchedule || null;
          this.cmsCheckRf = registerDisplay.checkRf || null;
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
        throw await handleXmdsError(data, status);
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

  async requiredFiles() {
      // Fetch when the CMS reports a list we have not fetched yet: the first collection after
      // startup, a change on the CMS, or a fetch that failed. Only then is the disk checked
      // too. Checking every file every time is slow, and a file only goes missing if someone
      // deletes it.
      const crc32 = this.cmsCheckRf;
      const verifyLocalFiles = crc32 == null || crc32 !== this.checkRf;

      // The CMS checksum only changes when the CMS changes, so it stays the same when a
      // download fails here. Missing files are checked separately, or they would never
      // be retried.
      if (verifyLocalFiles || hasUndownloadedFiles()) {
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
        soapXml, { timeout: XMDS_TIMEOUT_MS })
        .then(async (response) => {
          const requiredFiles = new RequiredFiles(response.data);
          await requiredFiles.parse();

          console.debug('XMDS RequiredFiles fetched', {
            method: 'XMDS::requiredFiles',
          });

          // Only now does this list count as fetched.
          this.checkRf = crc32;

          this.emitter.emit('requiredFiles', requiredFiles, verifyLocalFiles);
        })
        .catch((error: AxiosError) => {
          if (error.response?.status === 429) {
            // Handle 429 by setting cooldown and retrying this method later
            this.setRateLimit(
                method,
                error.response.headers?.['retry-after'],
                () => this.requiredFiles()
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
      soapXml, { timeout: XMDS_TIMEOUT_MS }
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

  async schedule() {
    const method = 'schedule';

    // Skip request if method was recently rate limited (429)
    if (this.isRateLimited(method)) {
      console.debug('[Xmds::schedule] skipped due to rate limit');
      return;
    }

    // Fetch when the CMS reports a schedule we have not fetched yet, as in requiredFiles().
    const crc32 = this.cmsCheckSchedule;

    if (crc32 == null || crc32 !== this.checkSchedule) {
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
        soapXml, { timeout: XMDS_TIMEOUT_MS })
        .then(async (response) => {
          const playerSchedule = new Schedule(response.data);
          await playerSchedule.parse();

          console.debug('XMDS Schedule fetched', {
            method: 'XMDS::schedule',
          });

          // Only now does this schedule count as fetched.
          this.checkSchedule = crc32;

          this.emitter.emit('schedule', playerSchedule);
        })
        .catch((error: AxiosError) => {
          if (error.response?.status === 429) {
            // Handle 429 by setting cooldown and retrying this method later
            this.setRateLimit(
                method,
                error.response.headers?.['retry-after'],
                () => this.schedule()
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
      soapXml, { timeout: XMDS_TIMEOUT_MS }
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

  /**
   * Submits the next batch of logs, unless a batch is already being submitted.
   */
  async handleSubmitLogs(db: ConsoleDB) {
    if (this.logsSubmitting) {
      console.debug('[Xmds::handleSubmitLogs] A batch is already being submitted, skipping');
      return;
    }

    // Cleared however the batch ends, so a failed or rejected one never blocks the next.
    this.logsSubmitting = true;

    try {
      await this.submitLogBatch(db);
    } finally {
      this.logsSubmitting = false;
    }
  }

  private async submitLogBatch(db: ConsoleDB) {
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

    if (logs.length === 0) {
      console.debug('[Xmds::handleSubmitLogs] > No logs to submit, clearing interval');

      if (this.logsInterval !== undefined) {
        clearInterval(this.logsInterval);
        this.logsInterval = undefined;
      }

      return;
    }

    // clear logsInterval when logs count < LogsThreshold
    if (logs.length < LogsThreshold && this.logsInterval !== undefined) {
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
      soapXml, { timeout: XMDS_TIMEOUT_MS }
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
    // Cap the backlog so logs cannot build up while the CMS is unreachable.
    db.pruneOldest(LogsMaxStored);

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
        await this.handleSubmitLogs(db);
      }, batchInterval * 1000);
    } else {
      if (this.logsInterval !== undefined) {
        clearInterval(this.logsInterval);
        this.logsInterval = undefined;
      }

      await this.handleSubmitLogs(db);
    }
  }

  // Resolves true only when the CMS confirms it stored the stats.
  async submitStats(statsXmlString: string): Promise<boolean> {
    const method = 'submitStats';

    // Skip request if method was recently rate limited (429)
    if (this.isRateLimited(method)) {
      console.debug('[Xmds::submitStats] skipped due to rate limit');
      return false;
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
      soapXml, { timeout: XMDS_TIMEOUT_MS })
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

        handleError(error);

        // The CMS did not confirm it received these, so they must be kept for the next attempt.
        return false;
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
      '     <status xsi:type-="xsd:string">' + escapeStringForXml(this.config.state.toJson(keys)) + '</status>\n' +
      '   </tns:NotifyStatus>\n' +
      ' </soap:Body>\n' +
      '</soap:Envelope>';

      return await axios.post(
        this.config.cmsUrl + '/xmds.php?v=' + this.config.xmdsVersion + '&method=notifyStatus',
        soapXml, { timeout: XMDS_TIMEOUT_MS }
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
      const response = await axios.post(this.config.cmsUrl + '/xmds.php?v=' + this.config.xmdsVersion, soapXml, { timeout: XMDS_TIMEOUT_MS });

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
      soapXml, { timeout: XMDS_TIMEOUT_MS }
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

  async getResource(file: RequiredFile): Promise<XmdsFetch<string>> {
    const method = 'getResource';

    // Skip request if method was recently rate limited (429)
    if (this.isRateLimited(method)) {
      console.debug('[Xmds::getResource] skipped due to rate limit');
      return { ok: false, rateLimited: true };
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
        soapXml, { timeout: XMDS_TIMEOUT_MS }
      )
        .then(async (response) => {
          const parser = new xml2js.Parser();
          const rootDoc = await parser.parseStringPromise(response.data);

          // Get the encoded XML
          const xml = rootDoc["SOAP-ENV:Envelope"]["SOAP-ENV:Body"][0]["ns1:GetResourceResponse"][0].resource[0]._;

          return { ok: true, data: xml } as XmdsFetch<string>;
        })
        .catch((error: AxiosError): XmdsFetch<string> => {
          console.error('[Xmds::getResource] > Error fetching resource XML: ', {
            error: error.message,
          });

          const rateLimited = error.response?.status === 429;

          if (rateLimited) {
            // Start the cooldown but do not retry here. This only fetches the file,
            // saving is done by the caller, so a retry would throw the file away.
            this.setRateLimit(method, error.response?.headers?.['retry-after']);
          }

          handleError(error)

          return { ok: false, rateLimited };
        });
    } catch (e) {
      console.error('[Xmds::getResource] > Error fetching resource XML: ', {
        e: e instanceof Error ? e.message : String(e),
      });

      handleError(e);

      return { ok: false, rateLimited: false };
    }
  }
  
  async getData(widgetId: RequiredFile['id']): Promise<XmdsFetch<string>> {
    const method = 'getData';

    // Skip request if method was recently rate limited (429)
    if (this.isRateLimited(method)) {
      console.debug('[Xmds::getData] skipped due to rate limit');
      return { ok: false, rateLimited: true };
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
        soapXml, { timeout: XMDS_TIMEOUT_MS }
      )
        .then(async (response) => {
          const parser = new xml2js.Parser();
          const rootDoc = await parser.parseStringPromise(response.data);

          // Get the encoded XML
          const xml = rootDoc["SOAP-ENV:Envelope"]["SOAP-ENV:Body"][0]["ns1:GetDataResponse"][0].data[0]._;

          return { ok: true, data: xml } as XmdsFetch<string>;
        })
        .catch((error: AxiosError): XmdsFetch<string> => {
          console.error('[Xmds::getData] > Error fetching data XML: ', {
            error: error.message,
          });

          const rateLimited = error.response?.status === 429;

          if (rateLimited) {
            // Start the cooldown but do not retry here. This only fetches the data,
            // saving is done by the caller, so a retry would throw the data away.
            this.setRateLimit(method, error.response?.headers?.['retry-after']);
          }

          handleError(error, 'Unable to fetch data for widget with id ' + widgetId);

          return { ok: false, rateLimited };
        });
    } catch (e) {
      console.error('[Xmds::getData] > Error fetching data XML: ', {
        e: e instanceof Error ? e.message : String(e),
      });

      handleError(e, 'Unable to fetch data for widget with id ' + widgetId);

      return { ok: false, rateLimited: false };
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

/**
 * Checks that the CMS behind `xmdsInstance.config`'s current cmsUrl/cmsKey is reachable and
 * registers the display against it. Shared between the first-run config panel (scratch Xmds
 * instance) and CMS-transfer flows (the live Xmds singleton).
 */
export async function validateAndRegister(xmdsInstance: Xmds) {
  try {
    const schemaVersion = await xmdsInstance.getSchemaVersion();

    // A CMS answers with a version number. Anything else, including a page of HTML that
    // parses as NaN, means the address is not one.
    if (!Number.isInteger(schemaVersion) || schemaVersion <= 0) {
      return {
        success: false,
        error: new Error(xmdsInstance.getSchemaVersionError()
          ?? 'That address did not return a CMS version. Check the CMS Address.'),
      };
    }

    const xmdsRegister = await xmdsInstance.registerDisplay();

    return { success: true, data: xmdsRegister };
  } catch (err) {
    return {
      success: false,
      error: err,
    };
  }
}
