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
import { CommandsCollection } from '../../../shared/command/commandManager';

/**
 * Register Display Response.
 */
export class RegisterDisplay {
  status: number | undefined;
  code: string | undefined;
  message: string | undefined;
  checkSchedule: string | undefined;
  checkRf: string | undefined;
  date: string | undefined;
  timezone: string | undefined;
  versionInstructions: string | undefined;
  private settings: unknown | undefined;

  private readonly response: string;

  /**
   * Expect either an awaiting auth message, or settings.
   * <?xml version="1.0" encoding="UTF-8"?>
   * <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="urn:xmds" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/" SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
   *     <SOAP-ENV:Body>
   *         <ns1:RegisterDisplayResponse>
   *             <ActivationMessage xsi:type="xsd:string">&lt;?xml version="1.0"?&gt;
   * &lt;display status="1" code="ADDED" message="Display is now Registered and awaiting Authorisation from an Administrator in the CMS" checkSchedule="" checkRf=""/&gt;
   * </ActivationMessage>
   *      OR
   *              <ActivationMessage xsi:type="xsd:string">&lt;?xml version="1.0"?&gt;
   *                  &lt;display date="2024-03-17 13:15:24" timezone="Europe/London" status="0" code="READY" message="Display is active and ready to start." version_instructions="" checkSchedule="" checkRf=""&gt;&lt;CollectInterval type="int"&gt;300&lt;/CollectInterval&gt;....
   *         </ns1:RegisterDisplayResponse>
   *     </SOAP-ENV:Body>
   * </SOAP-ENV:Envelope>
   * @param response
   */
  constructor(response: string) {
    this.response = response;
  }

  async parse() {
    const parser = new xml2js.Parser();
    const rootDoc = await parser.parseStringPromise(this.response);

    // Get the encoded XML
    const xml = rootDoc["SOAP-ENV:Envelope"]["SOAP-ENV:Body"][0]["ns1:RegisterDisplayResponse"][0].ActivationMessage[0]._;

    // Parse out attributes.
    const doc = await parser.parseStringPromise(xml);
    this.status = parseInt(doc.display.$.status ?? '0');
    this.code = doc.display.$.code ?? '';
    this.message = doc.display.$.message ?? '';
    this.checkSchedule = doc.display.$.checkSchedule ?? '';
    this.checkRf = doc.display.$.checkRf ?? '';
    this.date = doc.display.$.date ?? '';
    this.timezone = doc.display.$.timezone ?? '';
    this.versionInstructions = doc.display.$.version_instructions ?? '';

    console.debug('[RegisterDisplay::parse]', {
      doc,
    });

    // Store the settings nodes.
    this.settings = doc.display;
  }

  getSetting(setting: string, defaultValue: unknown) {
    if (!this.settings) {
      return defaultValue;
    }

    let settingValue = {
      source: 'default',
      value: defaultValue,
    };

    if (Boolean(this.settings[setting])) {
      if (Boolean(this.settings[setting][0]._)) {
        settingValue.source = '_';
        settingValue.value = this.settings[setting][0]._;
      } else {
        settingValue.source = '0';
        settingValue.value = this.settings[setting][0];
      }
    } else if (Boolean(this.settings['$'][setting])) {
      settingValue.source = '$';
      settingValue.value = this.settings['$'][setting];
    }
    
    if (setting === 'collectInterval' ||
      setting === 'offsetX' ||
      setting === 'offsetY' ||
      setting === 'sizeX' ||
      setting === 'sizeY' ||
      setting === 'screenShotRequested' ||
      setting === 'screenShotRequestInterval'
    ) {
      settingValue.value = parseInt(String(settingValue.value));
    }

    if (setting === 'sendCurrentLayoutAsStatusUpdate') {
      settingValue.value = Boolean(parseInt(String(settingValue.value)));
    }

    console.debug('[RegisterDisplay::getSetting]', {
      setting,
      defaultValue,
      settingSource: settingValue.source,
      settingValue: settingValue.value,
    })

    return settingValue.value;
  }

  getCommands(): CommandsCollection {
    const commandsNode = this.settings && this.settings['commands'];
    if (!commandsNode || !commandsNode.length) {
      return {};
    }

    const collection: CommandsCollection = {};

    for (const [commandCode, commandObject] of Object.entries(commandsNode[0])) {
      const cmd = (commandObject as any[])[0] as any;
      const commandString = cmd.commandString?.[0] ?? '';
      const validationString = cmd.validationString?.[0] ?? '';
      const createAlertOn = cmd.createAlertOn?.[0] ?? 'never';

      collection[commandCode] = {
        commandString,
        validationString,
        createAlertOn,
      };
    }

    return collection;
  }

  /** 
   * Returns display tags from the RegisterDisplay response as a name/value map.
   */
  getTags(): Record<string, string> {
    const tagsNode = this.settings && this.settings['tags'];
    if (!tagsNode || !tagsNode.length) {
      return {};
    }

    const tags: Record<string, string> = {};
    // XML parser wraps repeated elements in arrays, hence the [0] indexing.
    const tagList = tagsNode[0].tag;

    if (!tagList || !tagList.length) {
      return {};
    }

    for (const tagObject of tagList) {
      const tagName = tagObject.tagName?.[0] ?? '';
      const tagValue = tagObject.tagValue?.[0] ?? '';

      if (tagName) {
        tags[tagName] = tagValue;
      }
    }

    return tags;
  }
}
