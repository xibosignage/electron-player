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
import { DateTime } from "luxon";
import { Config } from "../config/config";

export class State {
  appVersionCode: string | number;
  lastXmrMessage: DateTime;
  availableSpace: number;
  totalSpace: number;
  lastCommandSuccess: boolean;
  deviceName: string;
  lanIpAddress: string;
  timeZone: string;
  currentLayoutId: number;
  width: number;
  height: number;
  latitude: number;
  longitude: number;
  scheduleLoop: string;
  ssp: string;
  displayStatus: number;

  constructor() {
    this.appVersionCode = -1;
    this.lastXmrMessage = DateTime.now().minus({ year: 1 });
    this.availableSpace = -1;
    this.totalSpace = -1;
    this.lastCommandSuccess = false;
    this.deviceName = '';
    this.lanIpAddress = '';
    this.timeZone = DateTime.now().toFormat('z');
    this.currentLayoutId = 0;
    this.width = 0;
    this.height = 0;
    this.latitude = 0;
    this.longitude = 0;
    this.scheduleLoop = '';
    this.ssp = '';
    this.displayStatus = 2;
  }

  toJson() {
    return JSON.stringify({
      availableSpace: this.availableSpace,
      totalSpace: this.totalSpace,
      lastCommandSuccess: this.lastCommandSuccess,
      deviceName: this.deviceName,
      lanIpAddress: this.lanIpAddress,
      timeZone: this.timeZone,
      currentLayoutId: this.currentLayoutId,
      width: this.width,
      height: this.height,
      latitude: this.latitude,
      longitude: this.longitude,
      statusDialog: JSON.stringify({
        appVersionCode: this.appVersionCode,
        lastXmrMessage: this.lastXmrMessage,
        userAgent: navigator.userAgent,
        scheduleLoop: this.scheduleLoop,
        ssp: this.ssp,
      }),
      displayStatus: this.displayStatus,
    });
  }

  toHtml(config: Config) {
    return '<h1 class="title">Status</h1>'
      + '<p>Date: ' + DateTime.now().toISO() + '</p>'
      + '<p>Version: ' + config.version + '</p>'
      + '<p>Version Code: ' + this.appVersionCode + '</p>'
      + '<p>URL: ' + config.cmsUrl + '</p>'
      + '<p>XMR: ' + this.lastXmrMessage.toISO() + '</p>'
      + '<br />'
      + '<p>SSP: ' + this.ssp + '</p>'
      + '<p>Schedule: ' + this.scheduleLoop + '</p>';
  }
}