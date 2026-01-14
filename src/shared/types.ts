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
import { InputLayoutType } from "@xibosignage/xibo-layout-renderer";

export interface ConfigData {
  platform: string;
  appType: string;
  version: string;
  versionCode: number;
  savePath: string;
  cmsSavePath: string;
  dbPath: string;
  hardwareKey?: string;
  xmrChannel?: string;
  cmsUrl?: string;
  cmsKey?: string;
  library: string;
  xmdsVersion?: number;
  displayName?: string;
  settings: any;
  isConfigured: boolean;
}

export type MainCallbackType = {
  context: 'main' | 'renderer';
}

export interface ApiHandler {
  loadConfig: () => Promise<ConfigData>;
  xmdsTryRegister: (config: ConfigData) => Promise<void>;
  getConfig: () => Promise<ConfigData>;
}

export interface PlayerAPI {
  // Main to render
  onConfigure: (callback: (config: ConfigData) => void) => void;
  onStateChange: (callback: (state: string) => void) => void;
  onUpdateLoop: (callback: (layouts: InputLayoutType[]) => void) => void;
  onUpdateUniqueLayouts: (callback: (layouts: InputLayoutType[]) => void) => void;
  onShowStatusWindow: (callback: (timeout: number) => void) => void;

  // Render to main
  openChildWindow: (url: string) => void;
  initFaults: (faults: any[]) => void;

  // Broadcast channel for stats
  sendStatsBCMessage: (payload: any) => void;
  onStatsBCMessage: (callback: (payload: any) => void) => void;

  // Callbacks
  requestCallback: () => Promise<{ callbackName: string }>;
  invokeCallback: (callbackName: string, ...args: any[]) => Promise<any>;
}
