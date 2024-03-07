/*
 * Copyright (c) 2024 Xibo Signage Ltd
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
import {join} from 'path';
import {machineId} from 'node-machine-id';

export class Config {
  // Environment
  readonly platform: string;

  // App information
  readonly version: string = "v4 R400";
  readonly versionCode: number = 400;

  // Config file
  readonly savePath: string;

  // Main configuration
  hardwareKey: string | undefined;
  cmsUrl: string | undefined;
  cmsKey: string | undefined;

  constructor(savePath, platform) {
    this.savePath = join(savePath, 'config.json');
    this.platform = platform;
  };

  async load() {
    console.log(`Loading ${ this.savePath }`);

    try {
      let data = await fs.readFile(this.savePath);
      data = JSON.parse(data);
      this.hardwareKey = data.hardwareKey;
      this.cmsUrl = data.cmsUrl;
      this.cmsKey = data.cmsKey;
    } catch {
      // Probably the file doesn't exist.
      this.hardwareKey = await machineId();
    }
  };

  async save() {
    console.log(`Saving ${ this.savePath }`);
    await fs.writeFile(
      this.savePath,
      JSON.stringify({
        hardwareKey: this.hardwareKey,
        cmsUrl: this.cmsUrl,
        cmsKey: this.cmsKey,
      }, null, 2),
    );
  };

  isConfigured() {
    return this.cmsUrl && this.cmsKey;
  }
}
