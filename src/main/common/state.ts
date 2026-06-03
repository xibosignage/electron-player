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

export interface StateData {
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
  allLayoutIds: string;
  statusDialog: {
    appVersionCode: string | number;
    lastXmrMessage: DateTime;
    userAgent: string;
    scheduleLoop: string;
    ssp: string;
  };
  displayStatus: number;
  invalidLayoutIds: number[];
  validLayoutIds: number[];
  activeFaults: Array<{code: number, reason: string, mediaId: number | null, layoutId: number | null, scheduleId: number | null}>;
  requiredFilesCount: number;
  downloadedFilesCount: number;
}

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
  allLayoutIds: string;
  ssp: string;
  displayStatus: number;
  invalidLayoutIds: number[];
  validLayoutIds: number[];
  activeFaults: Array<{code: number, reason: string, mediaId: number | null, layoutId: number | null, scheduleId: number | null}>;
  requiredFilesCount: number;
  downloadedFilesCount: number;
  missingFiles: string[];
  globalDependenciesCount: number;
  globalDependenciesReadyCount: number;
  missingGlobalDependencies: string[];
  usingCachedSchedule: boolean;
  nextScheduleUpdate: DateTime;
  pendingStatsCount: number;
  pendingLogsCount: number;
  recentLogs: Array<{level: string, message: string, timestamp: number}>;
  activeCriteria: Record<string, {metric: string, value: any, ttl: number}>;
  cmsUrl: string;
  version: string;

  constructor() {
    this.appVersionCode = -1;
    this.lastXmrMessage = DateTime.now().minus({ year: 1 });
    this.availableSpace = -1;
    this.totalSpace = -1;
    this.lastCommandSuccess = false;
    this.deviceName = '';
    this.cmsUrl = '';
    this.version = '';
    this.lanIpAddress = '';
    this.timeZone = DateTime.now().toFormat('z');
    this.currentLayoutId = 0;
    this.width = 0;
    this.height = 0;
    this.latitude = 0;
    this.longitude = 0;
    this.scheduleLoop = '';
    this.allLayoutIds = '';
    this.ssp = '';
    this.displayStatus = 2;
    this.invalidLayoutIds = [];
    this.validLayoutIds = [];
    this.activeFaults = [];
    this.requiredFilesCount = 0;
    this.downloadedFilesCount = 0;
    this.missingFiles = [];
    this.globalDependenciesCount = 0;
    this.globalDependenciesReadyCount = 0;
    this.missingGlobalDependencies = [];
    this.usingCachedSchedule = false;
    this.nextScheduleUpdate = DateTime.now();
    this.pendingStatsCount = 0;
    this.pendingLogsCount = 0;
    this.recentLogs = [];
    this.activeCriteria = {};
  }

  toJson(keys?: Partial<(keyof StateData)[]>): string {
    const stateData: any = {
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
      displayStatus: this.displayStatus,
      invalidLayoutIds: this.invalidLayoutIds,
      validLayoutIds: this.validLayoutIds,
      activeFaults: this.activeFaults,
    };
    const statusDialogData = {
      appVersionCode: this.appVersionCode,
      userAgent: navigator.userAgent,
      lastXmrMessage: this.lastXmrMessage,
      displayName: this.deviceName,
      screenSize: this.width + ' x ' + this.height,
      storage: this.totalSpace < 0 ? 'N/A' : (this.availableSpace / 1024 / 1024 / 1024).toFixed(1)
        + ' GB free of ' + (this.totalSpace / 1024 / 1024 / 1024).toFixed(1) + ' GB',
      memoryLimit: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB',
      memoryAllocation: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
      pendingStatsCount: this.pendingStatsCount,
      pendingLogsCount: this.pendingLogsCount,
      requiredFiles: this.downloadedFilesCount + ' / ' + this.requiredFilesCount,
      missingFiles: this.missingFiles,
      globalDependencies: this.globalDependenciesReadyCount + ' / ' + this.globalDependenciesCount,
      missingGlobalDependencies: this.missingGlobalDependencies,
      usingCachedSchedule: this.usingCachedSchedule,
      scheduleLoop: this.scheduleLoop,
      allLayoutIds: this.allLayoutIds,
      nextScheduleUpdate: this.nextScheduleUpdate,
      activeCriteria: JSON.stringify(this.activeCriteria, null, 2),
      ssp: this.ssp,
    };

    if (!keys) {
      stateData.statusDialog = JSON.stringify(statusDialogData);
      return JSON.stringify(stateData);
    }

    const filteredData: Partial<StateData> = {};
    for (const key of Object.keys(stateData) as (keyof StateData)[]) {

      if (keys?.includes(key)) {
        console.debug('[State::toJson] Checking key for status update', {
          key,
          included: keys.includes(key),
        });

        if (key === 'statusDialog') {
          (filteredData[key] as any) = JSON.stringify(statusDialogData);
        } else {
          (filteredData[key] as any) = stateData[key];
        }
      }
    }

    console.debug('[State::toJson] Filtered state data for status update', filteredData);

    return JSON.stringify(filteredData);
  }

  toHtml() {
    return '<h1 class="title">General Information</h1>'
      + '<p>Date: ' + DateTime.now().toISO() + '</p>'
      + '<p>Version: ' + this.version + '</p>'
      + '<p>Version Code: ' + this.appVersionCode + '</p>'
      + '<p>Content Management System: ' + this.cmsUrl + '</p>'
      + '<p>XMR Last Message: ' + this.lastXmrMessage.toISO() + '</p>'
      + '<p>LAN IP: ' + this.lanIpAddress + '</p>'
      + '<p>Latitude: ' + this.latitude + '</p>'
      + '<p>Longitude: ' + this.longitude + '</p>'
      + '<p>Storage: ' + (this.totalSpace < 0
        ? 'N/A'
        : (this.totalSpace / 1024 / 1024 / 1024).toFixed(1) + ' GB total, '
          + (this.availableSpace / 1024 / 1024 / 1024).toFixed(1) + ' GB free ('
          + Math.round((this.totalSpace - this.availableSpace) / this.totalSpace * 100) + '% used)')
      + '</p>'
      + '<p>Display Name: ' + this.deviceName + '</p>'
      + '<p>Current Layout: ' + this.currentLayoutId + '</p>'
      + '<p>Screen Size: ' + this.width + ' x ' + this.height + '</p>'
      + '<p>Memory Limit: ' + Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB</p>'
      + '<p>Memory Allocation: ' + Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB</p>'
      + '<p>Number of Stats ready to send: ' + this.pendingStatsCount + '</p>'
      + '<p>Number of Logs ready to send: ' + this.pendingLogsCount + '</p>'
      + '<p>Required Files: ' + this.downloadedFilesCount + ' / ' + this.requiredFilesCount + '</p>'
      + (this.missingFiles.length === 0 ? '' : '<p>Missing Required Files: ' + this.missingFiles.join(', ') + '</p>')
      + '<p>Global Dependencies: ' + this.globalDependenciesReadyCount + ' / ' + this.globalDependenciesCount + '</p>'
      + (this.missingGlobalDependencies.length === 0
        ? ''
        : '<p>Missing Global Dependencies: ' + this.missingGlobalDependencies.join(', ') + '</p>')
      + (this.usingCachedSchedule ? '<p>Schedule: Using cached schedule (last known from CMS)</p>' : '')
      + '<br />'
      + '<h1 class="title">Schedule Status</h1>'
      + '<p>All Layouts (* = not scheduled): ' + this.allLayoutIds + '</p>'
      + '<p>Scheduled Layouts: ' + this.scheduleLoop + '</p>'
      + '<p>Valid Layouts: ' + (this.validLayoutIds.length === 0 ? 'None' : this.validLayoutIds.join(', ')) + '</p>'
      + '<p>Invalid Layouts: ' + (this.invalidLayoutIds.length === 0 ? 'None' : this.invalidLayoutIds.join(', ')) + '</p>'
      + '<p>Next Schedule Update: ' + this.nextScheduleUpdate.toISO() + '</p>'
      + '<p>Active Criteria: </p>'
      + (Object.keys(this.activeCriteria).length === 0
        ? '<p>None</p>'
        : '<pre>' + JSON.stringify(this.activeCriteria, null, 2) + '</pre>')
      + '<p>SSP: ' + this.ssp + '</p>'
      + '<br />'
      + '<h1 class="title">Faults</h1>'
      + (this.activeFaults.length === 0
        ? '<p>None</p>'
        : this.activeFaults.map(f =>
          '<p>' + f.code + ': ' + f.reason
          + (f.layoutId ? ' (Layout: ' + f.layoutId + ')' : '')
          + (f.scheduleId ? ' (Schedule: ' + f.scheduleId + ')' : '')
          + '</p>'
        ).join(''))
      + '<br />'
      + '<h1 class="title">Last 5 Log Messages</h1>'
      + (this.recentLogs.length === 0
        ? '<p>None</p>'
        : this.recentLogs.map(l =>
          '<p>[' + new Date(l.timestamp).toISOString() + '] ' + l.level + ': ' + l.message + '</p>'
        ).join(''));
  }
}