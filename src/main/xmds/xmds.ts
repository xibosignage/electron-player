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
import { submitLogsXmlString } from '../common/parser';
import { AxiosErrorCodes, handleXmdsError } from '../common/error/XmdsError';

interface XmdsEvents {
  collecting: () => void;
  collected: () => void;
  registered: (message: RegisterDisplay) => void;
  requiredFiles: (object: RequiredFiles) => void;
  schedule: (object: Schedule) => void;
  submitLogs: () => void;
  reportFaults: () => void;
  submitStats: () => void;
}

export class Xmds {
  emitter: Emitter<XmdsEvents>;

  collectIntervalTime: number = 300;
  interval: NodeJS.Timeout | undefined;
  logsInterval: NodeJS.Timeout | undefined;
  hasSubmittedLogs: boolean | null = null;

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

    this.emitter.emit('collected');
  }

  async registerDisplay() {
    const soapXml = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:tns="urn:xmds" xmlns:types="urn:xmds/encodedTypes" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
      '  <soap:Body soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n' +
      '    <tns:RegisterDisplay>\n' +
      '      <serverKey xsi:type="xsd:string">' + this.config.cmsKey + '</serverKey>\n' +
      '      <hardwareKey xsi:type="xsd:string">' + this.config.hardwareKey + '</hardwareKey>\n' +
      '      <displayName xsi:type="xsd:string">' + this.config.displayName + '</displayName>\n' +
      '      <clientType xsi:type="xsd:string">' + this.config.getXmdsPlayerType() + '</clientType>\n' +
      '      <clientVersion xsi:type="xsd:string">' + this.config.version + '</clientVersion>\n' +
      '      <clientCode xsi:type="xsd:int">' + this.config.versionCode + '</clientCode>\n' +
      '      <macAddress xsi:type="xsd:string">n/a</macAddress>\n' +
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
    ).then(async ({ data, status }) => {
      if (status === 200) {
        // Parse out the checkRf/checkSchedule values and store them.
        const registerDisplay = new RegisterDisplay(data);
        await registerDisplay.parse();
        this.checkSchedule = registerDisplay.checkSchedule || null;
        this.checkRf = registerDisplay.checkRf || null;

        // Update the collection interval as necessary
        await this.updateInterval(registerDisplay.getSetting('collectInterval', 300) as number);

        // Save config
        this.config.save();
        this.config.saveCms();

        console.debug('Display registered', {
          method: 'XMDS::registerDisplay',
          checkSchedule: registerDisplay.checkSchedule,
          checkRf: registerDisplay.checkRf,
        });
        // Emit
        this.emitter.emit('registered', registerDisplay);
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
      // Make a new request.
      const soapXml = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:tns="urn:xmds" xmlns:types="urn:xmds/encodedTypes" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
        '  <soap:Body soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n' +
        '    <tns:RequiredFiles>\n' +
        '      <serverKey xsi:type="xsd:string">' + this.config.cmsKey + '</serverKey>\n' +
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
        .catch((error) => {
          // const err = handleError(error);
          // console.error(err.message);
          console.error(error);
        });
    }
  }

  async mediaInventory(files: string) {
    const soapXml = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:tns="urn:xmds" xmlns:types="urn:xmds/encodedTypes" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
      ' <soap:Body soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n' +
      '   <tns:MediaInventory>\n' +
      '     <serverKey xsi:type="xsd:string">' + this.config.cmsKey + '</serverKey>\n' +
      '     <hardwareKey xsi:type="xsd:string">' + this.config.hardwareKey + '</hardwareKey>\n' +
      '     <mediaInventory xsi:type-="xsd:string">&lt;files&gt;' + files + '&lt;/files&gt;</mediaInventory>\n' +
      '   </tns:MediaInventory>\n' +
      ' </soap:Body>\n' +
      '</soap:Envelope>';

    return await axios.post(
      this.config.cmsUrl + '/xmds.php?v=' + this.config.xmdsVersion + '&method=mediaInventory',
      soapXml
    );
  }

  async submitMediaInventory(mediaInventory: { xmlString: string; files: RequiredFile[] }) {
    if (mediaInventory.xmlString.length > 0) {
      // Report current state of files
      await this.mediaInventory(mediaInventory.xmlString);
    }

    return mediaInventory.files;
  }

  async schedule(crc32: string) {
    if (crc32 == null || crc32 != this.checkSchedule) {
      // Make a new request.
      const soapXml = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:tns="urn:xmds" xmlns:types="urn:xmds/encodedTypes" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
        '  <soap:Body soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n' +
        '    <tns:Schedule>\n' +
        '      <serverKey xsi:type="xsd:string">' + this.config.cmsKey + '</serverKey>\n' +
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
        .catch((error) => handleError(error));
    }
  }

  async screenshot() {
    // It is not possible to get screenshots from ChromeOS, but we need a screenshot to access notify status
    // and, it is a useful way to get "proof of life".
    const soapXml = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:tns="urn:xmds" xmlns:types="urn:xmds/encodedTypes" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
      ' <soap:Body soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n' +
      '   <tns:SubmitScreenShot>\n' +
      '     <serverKey xsi:type="xsd:string">' + this.config.cmsKey + '</serverKey>\n' +
      '     <hardwareKey xsi:type="xsd:string">' + this.config.hardwareKey + '</hardwareKey>\n' +
      '     <screenShot xsi:type-="xsd:base64Binary">iVBORw0KGgoAAAANSUhEUgAAAMgAAADIBAMAAABfdrOtAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAADUExURQAAAKd6PdoAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAArSURBVHja7cExAQAAAMKg9U9tCU8gAAAAAAAAAAAAAAAAAAAAAAAAALipAU7oAAG73DR2AAAAAElFTkSuQmCC</screenShot>\n' +
      '   </tns:SubmitScreenShot>\n' +
      ' </soap:Body>\n' +
      '</soap:Envelope>';

    try {
      return await axios.post(
        this.config.cmsUrl + '/xmds.php?v=' + this.config.xmdsVersion + '&method=',
        soapXml
      );
    } catch (e) {
      return handleError(e);
    }
  }

  async handleSubmitLogs(db: ConsoleDB) {
    const logLevel = this.config.getSetting('logLevel', 'error');
    const logLevelCategory = logLevel.charAt(0).toUpperCase() + logLevel.slice(1);
    const logs = db.getLogsByCategory(logLevelCategory, LogsThreshold);

    this.hasSubmittedLogs = false;

    if (logs.length === 0) {
      console.debug('[Xmds::handleSubmitLogs] > No logs to submit, clearing interval');

      if (this.logsInterval !== undefined) {
        this.hasSubmittedLogs = null;
        clearInterval(this.logsInterval);
      }

      return;
    }

    // clear logsInterval when logs count < LogsThreshold
    if (logs.length < LogsThreshold && this.logsInterval !== undefined) {
      this.hasSubmittedLogs = null;
      clearInterval(this.logsInterval);
    }

    let logsXmlStr = '';

    logs.forEach((log) => logsXmlStr += submitLogsXmlString(log));

    const soapXml = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:tns="urn:xmds" xmlns:types="urn:xmds/encodedTypes" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
      ' <soap:Body soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n' +
      '   <tns:SubmitLog>\n' +
      '     <serverKey xsi:type="xsd:string">' + this.config.cmsKey + '</serverKey>\n' +
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
      .catch((error) => {
        handleError(error, 'Unable to submit logs');
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

      // then submit backlog of logs in batch of LogsThreshold
      this.logsInterval = setInterval(async () => {
        if (this.hasSubmittedLogs || this.hasSubmittedLogs === null) {
          await this.handleSubmitLogs(db);
        }
      }, batchInterval * 1000);
    } else {
      if (this.logsInterval !== undefined) {
        clearInterval(this.logsInterval);
      }

      await this.handleSubmitLogs(db);
    }
  }

  async submitStats(statsXmlString: string) {
    // Make a new request.
    const soapXml = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:tns="urn:xmds" xmlns:types="urn:xmds/encodedTypes" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
      '  <soap:Body soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n' +
      '    <tns:SubmitStats>\n' +
      '      <serverKey xsi:type="xsd:string">' + this.config.cmsKey + '</serverKey>\n' +
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
      .catch((error) => handleError(error));
  }

  async notifyStatus() {
    const soapXml = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:tns="urn:xmds" xmlns:types="urn:xmds/encodedTypes" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
      ' <soap:Body soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n' +
      '   <tns:NotifyStatus>\n' +
      '     <serverKey xsi:type="xsd:string">' + this.config.cmsKey + '</serverKey>\n' +
      '     <hardwareKey xsi:type="xsd:string">' + this.config.hardwareKey + '</hardwareKey>\n' +
      '     <status xsi:type-="xsd:string">' + this.config.state.toJson() + '</status>\n' +
      '   </tns:NotifyStatus>\n' +
      ' </soap:Body>\n' +
      '</soap:Envelope>';

    try {
      return await axios.post(
        this.config.cmsUrl + '/xmds.php?v=' + this.config.xmdsVersion + '&method=notifyStatus',
        soapXml
      );
    } catch (e) {
      return handleError(e);
    }
  }

  async reportFaults() {
    console.debug('[Xmds::reportFaults] Reporting Faults to CMS');
    // try {
    //   const faults = new FaultsLib();
    //   const faultsParam = await faults.toJson();

    //   console.debug('[XMDS::reportFaults] > faultsParam', faultsParam);

    //   const soapXml = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:tns="urn:xmds" xmlns:types="urn:xmds/encodedTypes" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
    //       ' <soap:Body soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n' +
    //       '   <tns:ReportFaults>\n' +
    //       '     <serverKey xsi:type="xsd:string">' + this.config.cmsKey + '</serverKey>\n' +
    //       '     <hardwareKey xsi:type="xsd:string">' + this.config.hardwareKey + '</hardwareKey>\n' +
    //       '     <fault xsi:type-="xsd:string">' + faultsParam + '</fault>\n' +
    //       '   </tns:ReportFaults>\n' +
    //       ' </soap:Body>\n' +
    //       '</soap:Envelope>';

    //   return await axios.post(
    //     '/xmds.php?v=' + this.config.xmdsVersion + '&method=reportFaults',
    //     soapXml
    //   );
    // } catch (e) {
    //   return handleError(e);
    // }
  }

  async getResource(file: RequiredFile) {
    try {
      const soapXml = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:tns="urn:xmds" xmlns:types="urn:xmds/encodedTypes" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
        ' <soap:Body soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n' +
        '   <tns:GetResource>\n' +
        '     <serverKey xsi:type="xsd:string">' + this.config.cmsKey + '</serverKey>\n' +
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
        .catch((error) => {
          console.error('[Xmds::getResource] > Error fetching resource XML: ', {
            error,
          });

          handleError(error)
        });
    } catch (e) {
      console.error('[Xmds::getResource] > Error fetching resource XML: ', {
        e,
      });

      handleError(e);
    }
  }
}
