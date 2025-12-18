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
// @ts-ignore
import { contextBridge, ipcRenderer } from 'electron/renderer';
import { createExtendedConsole, serializeArgs } from '../shared/console/ExtendedConsole';
import { ApiHandler, ConfigData, PlayerAPI } from '../shared/types';

// Create renderer console that forwards logs to main via IPC
const extendedConsole = createExtendedConsole({
  context: 'renderer',
  sendToMain: (level, args) => {
    const logMessage = serializeArgs(args);
    console._log(`[ExtendedConsole::Renderer]`, { logMessage, args });
    ipcRenderer.invoke('renderer-log', level, logMessage);
  },
});

// Replace global console in renderer
(globalThis as any).console = extendedConsole;

contextBridge.exposeInMainWorld('__extendedConsole', extendedConsole);

const apiHandler: ApiHandler = {
  loadConfig: () => {
    return ipcRenderer.invoke('load-config');
  },
  xmdsTryRegister: async (config: ConfigData) => {
    const response = await ipcRenderer.invoke('xmds-try-register', config);

    if (!response.success && response.error) {
      throw new Error(response.error.message);
    }

    return response.data;
  },
  getConfig: () => ipcRenderer.invoke('get-config'),
}

contextBridge.exposeInMainWorld('apiHandler', apiHandler);

const playerApi: PlayerAPI = {
  // Main to render
  onConfigure: (callback) => ipcRenderer.on('configure', (_event, config: ConfigData) => callback(config)),
  onStateChange: (callback) => ipcRenderer.on('state-change', (_event, value) => callback(value)),
  onUpdateLoop: (callback) => ipcRenderer.on('update-loop', (_event, value) => callback(value)),
  onUpdateUniqueLayouts: (callback) => ipcRenderer.on('update-unique-layouts', (_event, value) => callback(value)),
  onShowStatusWindow: (callback) => ipcRenderer.on('showStatusWindow', (_event, timeout) => callback(timeout)),

  // Render to main
  openChildWindow: (url) => ipcRenderer.send('open-child-window', url),
  initFaults: (faults) => ipcRenderer.send('initFaults', faults),

  // Broadcast channel for stats
  sendStatsBCMessage: (payload: any) => ipcRenderer.send('stats-bc-message', payload),
  onStatsBCMessage: (callback: (payload: any) => void) => {
    ipcRenderer.on('stats-bc-message', (_event, payload) => callback(payload));
  },

  requestCallback: async () => {
    return await ipcRenderer.invoke('request-callback');
  },
  invokeCallback: async (callbackName, ...args) => {
    return await ipcRenderer.invoke('invoke-callback', {
      callbackName,
      args,
    });
  },
};

contextBridge.exposeInMainWorld('playerAPI', playerApi);
