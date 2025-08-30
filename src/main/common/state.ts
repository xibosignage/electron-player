/*
 * Copyright (c) Xibo Signage Ltd 2025.
 * All rights reserved.
 */

import {DateTime} from "luxon";
import {Config} from "../config/config";

export class State {
  swVersion: number;
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
  logLevel: string;
  statsEnabled: boolean;
  aggregationLevel: string;
  scheduleLoop: string;
  ssp: string;
  displayStatus: number;

  constructor() {
    this.swVersion = -1;
    this.lastXmrMessage = DateTime.now().minus({year: 1});
    this.availableSpace = -1;
    this.totalSpace = -1;
    this.lastCommandSuccess = false;
    this.deviceName = 'chromeOS';
    this.lanIpAddress = '';
    this.timeZone = DateTime.now().toFormat('z');
    this.currentLayoutId = 0;
    this.width = 0;
    this.height = 0;
    this.latitude = 0;
    this.longitude = 0;
    this.logLevel = 'error';
    this.statsEnabled = false;
    this.aggregationLevel = 'Individual';
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
        swVersion: this.swVersion,
        lastXmrMessage: this.lastXmrMessage,
        userAgent: navigator.userAgent,
        scheduleLoop: this.scheduleLoop,
        ssp: this.ssp,
      }),
      logLevel: this.logLevel,
      statsEnabled: this.statsEnabled,
      aggregationLevel: this.aggregationLevel,
      displayStatus: this.displayStatus,
    });
  }

  toHtml(config: Config) {
    return '<h1 class="title">Status</h1>'
      + '<p>Date: ' + DateTime.now().toISO() + '</p>'
      + '<p>Version: ' + config.version + '</p>'
      + '<p>Version Code: ' + this.swVersion + '</p>'
      + '<p>XMR: ' + this.lastXmrMessage.toISO() + '</p>'
      + '<br />'
      + '<p>SSP: ' + this.ssp + '</p>'
      + '<p>Schedule: ' + this.scheduleLoop + '</p>';
  }
}