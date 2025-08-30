/*
 * Copyright (c) 2023-2024 Xibo Signage Ltd
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
import {contextBridge, ipcRenderer} from 'electron/renderer';

contextBridge.exposeInMainWorld('electron', {
  // Main to render
  onConfigure: (callback) => ipcRenderer.on('configure', (_event, value) => callback(value)),

  // Render to main
  openChildWindow: (url) => ipcRenderer.send('open-child-window', url),
  xmdsTryRegister: (cmsUrl, cmsKey, displayName) => ipcRenderer.send('xmds-try-register', cmsUrl, cmsKey, displayName),
});
