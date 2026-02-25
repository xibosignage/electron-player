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
const fs = require('fs/promises');
import { join } from 'path';
import { machineId } from 'node-machine-id';
import { RegisterDisplay } from '../xmds/response/registerDisplay';
import { State } from '../common/state';
import { randomUUID } from 'crypto';

export class Config {
  // Environment
  readonly platform: string;
  readonly appType: string = 'electron';

  // App information
  version: string = __APP_VERSION__;
  versionCode: number = __APP_VERSION_CODE__;

  // Config file
  readonly savePath: string;
  readonly cmsSavePath: string;
  readonly dbPath: string;

  // State
  state: State;

  // Main configuration
  hardwareKey: string | undefined;
  xmrChannel: string | undefined;
  cmsUrl: string | undefined;
  cmsKey: string | undefined;
  library: string;

  // Settings from the CMS
  xmdsVersion: number | undefined;
  displayName: string | undefined;
  settings: any;

  constructor(app: Electron.App, platform: string, state: State) {
    const savePath = app.getPath('userData');
    this.savePath = join(savePath, 'config.json');
    this.cmsSavePath = join(savePath, 'cms_config.json');
    this.platform = platform;
    this.library = join(app.getPath('documents'), 'xibo_library');
    this.dbPath = join(savePath, 'playerDb.db');
    this.settings = {};
    this.state = state;
    this.state.appVersionCode = this.versionCode;
  };

  async load() {
    console.log(`Loading ${this.savePath}`);

    try {
      let data = await fs.readFile(this.savePath);
      data = JSON.parse(data);
      this.hardwareKey = data.hardwareKey ?? (await machineId()).substring(0, 40);
      this.cmsUrl = data.cmsUrl;
      this.cmsKey = data.cmsKey;
      this.xmrChannel = data.xmrChannel ?? randomUUID();
    } catch {
      // Probably the file doesn't exist.
      this.hardwareKey = (await machineId()).substring(0, 40);
      this.xmrChannel = randomUUID();
      await this.save();
    }

    console.log(`Loading ${this.cmsSavePath}`);

    try {
      let data = await fs.readFile(this.cmsSavePath);
      data = JSON.parse(data);
      this.displayName = data.displayName;
      this.xmdsVersion = data.xmdsVersion;
      this.settings = data.settings || {};
    } catch {
      // Probably the file doesn't exist.
      this.displayName = this.platform + ' Unknown player';
      await this.saveCms();
    }
  };

  async save() {
    console.log(`Saving ${this.savePath}`);
    await fs.writeFile(
      this.savePath,
      JSON.stringify({
        hardwareKey: this.hardwareKey,
        xmrChannel: this.xmrChannel,
        cmsUrl: this.cmsUrl,
        cmsKey: this.cmsKey,
      }, null, 2),
    );
  };

  async saveCms() {
    console.log(`Saving ${this.cmsSavePath}`);
    await fs.writeFile(
      this.cmsSavePath,
      JSON.stringify({
        displayName: this.displayName,
        xmdsVersion: this.xmdsVersion,
        settings: this.settings,
      }, null, 2),
    );
  };

  isConfigured() {
    const isCmsUrlSet = this.cmsUrl !== undefined && this.cmsUrl !== null && this.cmsUrl.trim() !== '';
    const isCmsKeySet = this.cmsKey !== undefined && this.cmsKey !== null && this.cmsKey.trim() !== '';

    return isCmsUrlSet && isCmsKeySet;
  }

  isLicensed() {
    return true;
    // return this.licence.licensed;
  }

  async setConfig(registerDisplay: RegisterDisplay) {
    console.log(`Set config from register display`);
    this.settings['licenceCode'] = registerDisplay.getSetting('licenceCode', null);
    this.settings['collectionInterval'] = registerDisplay.getSetting('collectInterval', 300);
    this.settings['xmrWebSocketAddress'] = registerDisplay.getSetting('xmrWebSocketAddress', null);
    this.settings['xmrCmsKey'] = registerDisplay.getSetting('xmrCmsKey', null);
    this.settings['isSspEnabled'] = registerDisplay.getSetting('isAdspaceEnabled', 0) === '1';
    this.settings['logLevel'] = registerDisplay.getSetting('logLevel', 'error');
    this.settings['aggregationLevel'] = registerDisplay.getSetting('aggregationLevel', 'Individual');
    this.settings['statsEnabled'] = registerDisplay.getSetting('statsEnabled', false) === '1';
    this.state.displayStatus = registerDisplay.status || 0;

    this.saveCms();
  }

  getSetting(setting: string, defaultValue?: any) {
    if (setting == 'library') {
      return this.library;
    }
    if (this.settings && this.settings[setting]) {
      return this.settings[setting];
    } else {
      return defaultValue || null;
    }
  }

  getXmdsPlayerType(): string {
    // Temporary until we get a suitable display profile into the CMS
    return 'linux'
    // We have a different display profile for electron on windows vs electron on linux.
    //return this.platform == 'win32' ? 'electron-win' : 'electron-linux';
  }

  toJson(): string {
    return JSON.stringify({
      platform: this.platform,
      appType: this.appType,
      version: this.version,
      versionCode: this.versionCode,
      savePath: this.savePath,
      cmsSavePath: this.cmsSavePath,
      dbPath: this.dbPath,
      hardwareKey: this.hardwareKey,
      xmrChannel: this.xmrChannel,
      cmsUrl: this.cmsUrl,
      cmsKey: this.cmsKey,
      library: this.library,
      xmdsVersion: this.xmdsVersion,
      displayName: this.displayName,
      settings: this.settings,
      isConfigured: this.isConfigured(),
      state: this.state.toJson(),
    });
  }
}
