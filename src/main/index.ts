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
if (require('electron-squirrel-startup')) app.quit();

import { installExtension, JQUERY_DEBUGGER } from 'electron-devtools-installer';
import {app, shell, WebContentsView, BrowserWindow, ipcMain} from 'electron';
import {join} from 'path';
import {optimizer, is} from '@electron-toolkit/utils';
import icon from '../../resources/icon.png?asset';
import {spawn} from 'child_process';
import {Config} from './config/config';
import {Xmds} from './xmds/xmds';
import {Xmr} from '@xibosignage/xibo-communication-framework';
import {State} from './common/state';

const state = new State();
state.width = 1280;
state.height = 720;

let xmds;
let xmr;

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    backgroundColor: '#000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    frame: false,
    icon: icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  });

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return {action: 'deny'};
  });

  win.setMenuBarVisibility(false);

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']).then(() => {
      init(win);
    });
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html')).then(() => {
      init(win);
    });
  }
};

const init = (win) => {
  // Configure IPC
  configureIpc(win);

  // TODO: Configure a new folder for local files.

  // Create a new Config object
  const config = new Config(app.getPath('userData'), process.platform, state);
  config.load().then(async() => {
    // eslint-disable-next-line max-len
    console.log(`Version: ${config.version}, hardwareKey: ${config.hardwareKey}`);

    // Are we configured?
    if (!config.isConfigured()) {
      console.log('Not configured, showing configuration page');

      // Bind to some events from the renderer for configuration.
      ipcMain.on('xmds-try-register', (_event, cmsUrl, cmsKey, displayName) => {
        console.log('xmds-try-register: ' + cmsUrl + ', ' + cmsKey + ', ' + displayName);
        // const xmds = new Xmds(config, app.getPath('appData'));
      });

      // Switch to the configuration page in the renderer.
      win.webContents.send('configure', config);
    } else {
      // We are configured so continue starting the rest of the application.
      console.log('Configured.');

      // Player API and static file serving
      configureExpress();

      // Configure the renderer
      win.webContents.send('configure', config);

      // Configure XMDS
      xmds = new Xmds(config, app.getPath('appData'));
      
      // Configure XMR
      xmr = new Xmr(config.xmrChannel || 'unknown');

      // Initialize XMR
      await xmr.init();      

      // Bind to some events
      xmds.on('registered', (data) => {
        console.debug('[Xmds::on("registered")] > Registered', {
          registerDisplay: data,
          shouldParse: false,
        });

        config.setConfig(data);

        // XMDS register was a success, so we should create an XMR instance
        // TODO: Web Sockets are only supported by the CMS if the XMDS version is 7, otherwise ZeroMQ web sockets should be used.
        // Use ws not http 
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

        // If the CMS has sent an alternative WS address, use that instead.
        let xmrWebSocketAddress = config.getSetting(
          'xmrWebSocketAddress',
          config.cmsUrl?.replace(window.location.protocol, protocol) + '/xmr'
        );
        xmr.start(xmrWebSocketAddress, config.getSetting('xmrCmsKey', 'n/a'));
      });

      xmds.on('requiredFiles', (data) => {
        console.debug('[Xmds::on("requiredFiles")] > Required Files', {
          registerDisplay: data,
          shouldParse: false,
        });
      });

      // Bind to some XMR events
      xmr.on('connected', () => {
        console.log('XMR Connected');
      });

      xmds.getSchemaVersion().then((version) => {
        config.xmdsVersion = version;
        
        xmds.start(config.getSetting('collectionInterval', 60));
      });

      // Set up a regular status update push
      setInterval(() => {
        win.webContents.send('state-change', state.toHtml(config));
      }, 5000);
    }
  });
};

const configureIpc = (win) => {
  ipcMain.on('open-child-window', (_event, url) => {
    const view = new WebContentsView();
    win.contentView.addChildView(view);
    view.setBounds({x: 0, y: 0, width: 800, height: 600});
    view.webContents.loadURL(url);
  });
};

const configureExpress = () => {
  // Start express
  const appName = app.getPath('exe');
  const expressPath = is.dev ?
    './out/main/express.js' :
    join('./resources/app.asar', './out/main/express.js');
  const redirectOutput = function(stream) {
    stream.on('data', (data) => {
      data.toString().split('\n').forEach((line) => {
        console.log(line);
      });
    });
  };

  console.log(expressPath);

  const expressAppProcess =
      spawn(appName, [expressPath], {env: {ELECTRON_RUN_AS_NODE: '1'}});
  [expressAppProcess.stdout, expressAppProcess.stderr].forEach(redirectOutput);
};

app.whenReady().then(() => {
  // Install dev tools extension.
  installExtension(JQUERY_DEBUGGER)
        .then((ext) => console.log(`Added Extension:  ${ext.name}`))
        .catch((err) => console.log('An error occurred: ', err));

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
