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
import {Config} from "../config/config";
import axios from "axios";
import {createNanoEvents, Emitter} from 'nanoevents';

import {RegisterDisplay} from './response/registerDisplay';
import { ErrorCodes, handleError } from "./error/error";
import RequiredFiles, { RequiredFileType } from "./response/requiredFiles";
import Schedule from "./response/schedule/schedule";
import { mediaInventoryFileXmlString } from '../common/parser';
// import FaultsLib from "../../renderer/src/lib/faultsLib";

interface XmdsEvents {
  collecting: () => void;
  collected: () => void;
  registered: (message: RegisterDisplay) => void;
  requiredFiles: (object: RequiredFiles) => void;
  schedule: (object: Schedule) => void;
}

export class Xmds {
  readonly config: Config;
  readonly savePath: string;

  emitter: Emitter<XmdsEvents>;

  collectIntervalTime: number = 300;
  interval: NodeJS.Timeout | undefined;

  // CRC32
  checkRf: string | null = null;
  checkSchedule: string | null = null;

  constructor(config, savePath) {
    this.config = config;
    this.savePath = savePath;

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
    if (intervalTime !== this.collectIntervalTime) {
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

      await this.requiredFiles(checkRf ?? '');
      await this.schedule(checkSchedule ?? '');

      await this.notifyStatus();
      await this.reportFaults();
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
        soapXml)
        .then(async (response) => {
          // Parse out the checkRf/checkSchedule values and store them.
          const registerDisplay = new RegisterDisplay(response.data);
          await registerDisplay.parse();
          this.checkSchedule = registerDisplay.checkSchedule || null;
          this.checkRf = registerDisplay.checkRf || null;

          // Update the collection interval as necessary
          await this.updateInterval(registerDisplay.getSetting('collectInterval', 300));

          console.debug('Display registered', {
            method: 'XMDS::registerDisplay',
            checkSchedule: registerDisplay.checkSchedule,
            checkRf: registerDisplay.checkRf,
          });
          // Emit
          this.emitter.emit('registered', registerDisplay);
        });
  }

  async requiredFiles(crc32: string) {
    if (crc32 == "" || crc32 != this.checkRf) {
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
        .then(async(response) => {
          const requiredFiles = new RequiredFiles(response.data);
          await requiredFiles.parse();

          console.debug('XMDS RequiredFiles fetched', {
            method: 'XMDS::requiredFiles',
          });

          this.emitter.emit('requiredFiles', requiredFiles);
        })
        .catch((error) => {
          const err = handleError(error);
          console.error(err.message);
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

  async submitMediaInventory(files: RequiredFileType[], isComplete: boolean = false) {
      // Store xmlFileString for mediaInventory use
      const requiredFiles = await Promise.all(files.map((fileObj) => {
          return {
            xmlString: mediaInventoryFileXmlString({
              id: fileObj.id,
              type: fileObj.type as string,
              fileType: fileObj.fileType,
              size: fileObj.size,
              md5: fileObj.md5,
              path: fileObj.path,
              saveAs: fileObj.saveAs,
            }, isComplete),
            copy: fileObj,
        };
      }));

      const [xmlFilesString, mediaFiles] = requiredFiles.reduce(
        ([filesString, fileObj]: [string, RequiredFileType[]], b) => {
          filesString += b.xmlString;
          
          return [filesString, [...fileObj, b.copy]];
        }, ['', [] as RequiredFileType[]]);

      if (xmlFilesString.length > 0) {
          // Report current state of files
          await this.mediaInventory(xmlFilesString);
      }

      return mediaFiles;
  }

  async schedule(crc32: string) {
    if (crc32 == "" || crc32 != this.checkSchedule) {
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
        .then(async(response) => {
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
        '/xmds.php?v=' + this.config.xmdsVersion + '&method=',
        soapXml
      );
    } catch (e) {
      return handleError(e);
    }
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

  async getResource(file: RequiredFileType) {
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
      .then(async(response) => {
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
