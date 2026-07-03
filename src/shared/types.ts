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
import { InputLayoutType, IXlrEvents } from "@xibosignage/xibo-layout-renderer";
import { StateData } from "../main/common/state";

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
  state: StateData;
}

export type MainCallbackType = {
  context: 'main' | 'renderer';
}

export type SspAdData = {
  url: string;
  xiboType: string;
  duration: number;
  width: number;
  height: number;
  impressionUrls: string[];
  errorUrls: string[];
};

/**
 * A single eligible data connector, sent from main to the renderer so the
 * renderer's DataConnectorManager can host it. `js` is the connector script
 * filename served by the local file server (appHost + js); `md5` is the
 * CMS-advertised hash main verified against the on-disk file before sending,
 * and doubles as the restart discriminator (alongside scheduleId/dataParams).
 */
export type DataConnectorPayload = {
  dataSetId: number;
  scheduleId: number;
  dataParams: string;
  js: string;
  md5: string;
};

/**
 * Result of a renderer → main realtime write. Mirrors the success/status shape
 * the connector bridge expects so it can resolve the connector's done/error
 * callbacks.
 */
export type RealtimeSetResult = {
  success: boolean;
  status: number;
};

export interface ApiHandler {
  loadConfig: () => Promise<ConfigData>;
  xmdsTryRegister: (config: ConfigData) => Promise<void>;
  getConfig: () => Promise<ConfigData>;
  executeXlrEvent: (eventName: keyof IXlrEvents, payload: any) => Promise<void>;
  sspGetAd: () => Promise<SspAdData | null>;
  sspReportImpression: (urls: string[], duration: number, lat: number | null, lng: number | null) => Promise<void>;
  sspReportError: (urls: string[], code: number) => Promise<void>;
  sspGetWidgetAd: (partnerId: string) => Promise<SspAdData | null>;
  sspReportWidgetImpression: (urls: string[], duration: number) => Promise<void>;
  findLayoutByCode: (code: string) => Promise<{ layoutId: number; name: string } | null>;

  // Data connector (renderer → main)
  // Store/clear realtime data, and relay connector-set schedule criteria into
  // the main process where data connectors and layouts are assessed.
  realtimeSet: (dataKey: string, dataSetId: number, data: string) => Promise<RealtimeSetResult>;
  realtimeClear: (dataSetId: number) => Promise<void>;
  connectorCriteria: (metric: string, value: any, ttl?: number) => Promise<void>;
  connectorRequest: (path: string, options: {
    method?: string;
    headers?: Record<string, string>;
    data?: string;
  }) => Promise<{ ok: boolean; status: number; body: string }>;
}

export interface PlayerAPI {
  // Main to render
  onConfigure: (callback: (config: ConfigData) => void) => void;
  onStateChange: (callback: (state: string) => void) => void;
  onUpdateLoop: (callback: (layouts: InputLayoutType[]) => void) => void;
  onUpdateUniqueLayouts: (callback: (layouts: InputLayoutType[]) => void) => void;
  onUpdateOverlays: (callback: (overlays: InputLayoutType[]) => void) => void;
  onShowStatusWindow: (callback: (timeout: number) => void) => void;
  onTriggerWebhook: (callback: (payload: { triggerCode: string; widgetId?: string }) => void) => void;
  onXlrExpireWidget: (callback: (widgetId: string) => void) => void;
  onXlrExtendWidgetDuration: (callback: (widgetId: string, duration: number) => void) => void;
  onXlrSetWidgetDuration: (callback: (widgetId: string, duration: number) => void) => void;
  onUpdateDataConnectors: (callback: (connectors: DataConnectorPayload[]) => void) => void;

  // Render to main
  openChildWindow: (url: string) => void;
  initFaults: (faults: any[]) => void;
  notifyStatusWindowVisibility: (visible: boolean) => void;

  // Broadcast channel for stats
  sendStatsBCMessage: (payload: any) => void;
  onStatsBCMessage: (callback: (payload: any) => void) => void;

  // Broadcast channel for faults
  reportFault: (faultData: any) => void;
  onReportFault: (callback: (faultData: any) => void) => void;

  // Callbacks
  requestCallback: () => Promise<{ callbackName: string }>;
  invokeCallback: (callbackName: string, ...args: any[]) => Promise<any>;
}
