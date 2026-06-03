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
import { randomUUID } from 'crypto';
import os from 'os';

import { RegisterDisplay } from '../xmds/response/registerDisplay';
import { State } from '../common/state';

export class Config {
  // Environment
  readonly platform: string;
  readonly appType: string = 'electron';

  // App information
  readonly version: string = __APP_VERSION__;
  readonly versionCode: number = __APP_VERSION_CODE__;

  // Config file
  readonly savePath: string;
  readonly cmsSavePath: string;
  readonly dbPath: string;

  // Write queues — serialize concurrent writes per file
  private _saveQueue: Promise<void> = Promise.resolve();
  private _saveCmsQueue: Promise<void> = Promise.resolve();

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

  // Device info
  macAddress: string = '';

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

    console.alert(`Player version is ${this.versionCode}`, {
      shouldParse: false,
      eventType: 'Other',
      alertType: 'both',
    });

    console.alert(`Starting ${this.appType} application`, {
      shouldParse: false,
      eventType: 'App Start',
      alertType: 'both',
    });

    try {
      let data = await fs.readFile(this.savePath);
      data = JSON.parse(data);
      this.hardwareKey = data.hardwareKey ?? (await machineId()).substring(0, 40);
      this.cmsUrl = data.cmsUrl;
      this.cmsKey = data.cmsKey;
      this.xmrChannel = data.xmrChannel ?? randomUUID();
      this.macAddress = data.macAddress || this.getMacAddress();
    } catch {
      // Probably the file doesn't exist.
      this.hardwareKey = (await machineId()).substring(0, 40);
      this.xmrChannel = randomUUID();
      this.macAddress = this.getMacAddress();
      await this.save();
    }

    console.log(`Loading ${this.cmsSavePath}`);

    try {
      let data = await fs.readFile(this.cmsSavePath);
      data = JSON.parse(data);
      this.displayName = data.displayName;
      this.xmdsVersion = data.xmdsVersion;
      this.settings = data.settings || {};

      // Restore the last known approval status so offline boots can still attempt collection.
      // Default 2 means not registered, which correctly blocks collection on a fresh install.
      this.state.displayStatus = data.displayStatus ?? 2;
    } catch {
      // Probably the file doesn't exist.
      this.displayName = this.platform + ' Unknown player';
      await this.saveCms();
    }
  };

  async save() {
    this._saveQueue = this._saveQueue
      .then(() => this._doSave())
      .catch((err) => console.error(`[Config::save] Failed to save config:`, err));
    return this._saveQueue;
  };

  private async _doSave() {
    console.log(`Saving ${this.savePath}`);
    const tmp = this.savePath + '.tmp';
    await fs.writeFile(
      tmp,
      JSON.stringify({
        hardwareKey: this.hardwareKey,
        xmrChannel: this.xmrChannel,
        cmsUrl: this.cmsUrl,
        cmsKey: this.cmsKey,
        macAddress: this.macAddress,
        platform: this.platform,
      }, null, 2),
    );
    await fs.rename(tmp, this.savePath);
  };

  async saveCms() {
    this._saveCmsQueue = this._saveCmsQueue
      .then(() => this._doSaveCms())
      .catch((err) => console.error(`[Config::saveCms] Failed to save CMS config:`, err));
    return this._saveCmsQueue;
  };

  private async _doSaveCms() {
    console.log(`Saving ${this.cmsSavePath}`);
    const tmp = this.cmsSavePath + '.tmp';
    await fs.writeFile(
      tmp,
      JSON.stringify({
        displayName: this.displayName,
        xmdsVersion: this.xmdsVersion,
        settings: this.settings,
        displayStatus: this.state.displayStatus,
      }, null, 2),
    );
    await fs.rename(tmp, this.cmsSavePath);
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
    this.settings['offsetX'] = registerDisplay.getSetting('offsetX', 0);
    this.settings['offsetY'] = registerDisplay.getSetting('offsetY', 0);
    this.settings['sizeX'] = registerDisplay.getSetting('sizeX', 0);
    this.settings['sizeY'] = registerDisplay.getSetting('sizeY', 0);
    this.settings['sendCurrentLayoutAsStatusUpdate'] = registerDisplay.getSetting('sendCurrentLayoutAsStatusUpdate', false);
    this.state.displayStatus = registerDisplay.status || 0;

    await this.saveCms();
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

  getMacAddress(): string {
    const interfaces = os.networkInterfaces();
    for (const name in interfaces) {
      const networkInterface = interfaces[name];
      if (networkInterface === undefined) continue;

      for (const details of networkInterface) {
        // Skip internal (loopback) and virtual addresses
        if (details.mac && details.mac !== '00:00:00:00:00:00' && !details.internal) {
          return details.mac;
        }
      }
    }

    return 'n/a';
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
