/*
 * Copyright (c) Xibo Signage Ltd 2025.
 * All rights reserved.
 */

export declare class State {
  swVersion: number;
  lastXmrMessage: DateTime;
  availableSpace: number;
  totalSpace: number;
  lastCommandSuccess: boolean;
  deviceName: string;
  lanIpAddress: string;
  licenceResult: string;
  timeZone: string;
  currentLayoutId: number;
  width: number;
  height: number;
  latitude: number;
  longitude: number;
  statusDialog: any;
  logLevel: string;

  toJson(): string;
  toHtml(): string;
}