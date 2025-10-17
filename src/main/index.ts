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

const fs = require('fs/promises');
import { installExtension, JQUERY_DEBUGGER } from 'electron-devtools-installer';
import {app, shell, WebContentsView, BrowserWindow, ipcMain, session} from 'electron';
import {join} from 'path';
import {optimizer, is} from '@electron-toolkit/utils';
import {Xmr} from '@xibosignage/xibo-communication-framework';

import icon from '../../resources/icon.png?asset';
import {spawn} from 'child_process';
import {Config} from './config/config';
import {Xmds} from './xmds/xmds';
import {State} from './common/state';
import { createFileServer } from './express';
import { downloadFile, downloadResourceFile, getDownloadedFiles, getLayoutFile, RequiredFileType } from './common/fileManager';
import Schedule from './xmds/response/schedule/schedule';
import ScheduleManager from './common/scheduleManager';
import { InputLayoutType } from './common/types';
// import FaultsLib from '../renderer/src/lib/faultsLib';

const state = new State();
state.width = 1280;
state.height = 720;

let xmds;
let xmr;
let schedule: Schedule;
let manager: ScheduleManager;

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
      webSecurity: true,
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

const initXmrEventHandlers = async function() {
  // Bind to some XMR events
  xmr.on('connected', () => {
    console.log('XMR Connected');
  });
  xmr.on('collectNow', () => {
    console.debug('Requesting a collection immediately', {method: 'Xmr::screenShot'});
    xmds.collectNow();
  });
  xmr.on('screenShot', async () => {
    console.debug('Requesting a screenshot', {method: 'Xmr::screenShot'});
    await xmds.screenshot();
    await xmds.notifyStatus();
  });
  // xmr.on('licenceCheck', async () => {
  //   console.debug('Requesting a licence check', {method: 'Xmr::licenceCheck'});
  //   await config.checkLicence(true, 0);
  //   await xmds.notifyStatus();
  // });
  // xmr.on('showStatusWindow', async(timeout) => {
  //   $statusWindow?.style.setProperty('display', 'block');
  //   setTimeout(() => {
  //     $statusWindow?.style.setProperty('display', 'none');
  //   }, timeout * 1000);
  // });
}

const initXmdsEventHandlers = async function() {
  const config = new Config(app, process.platform, state);

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
    if (!config.cmsUrl) {
      return;
    }
    const url = new URL(config.cmsUrl);
    const protocol = url.protocol == 'https:' ? 'wss:' : 'ws:';

    // If the CMS has sent an alternative WS address, use that instead.
    let xmrWebSocketAddress = config.getSetting(
      'xmrWebSocketAddress',
      config.cmsUrl?.replace(url.protocol, protocol) + '/xmr'
    );
    xmr.start(xmrWebSocketAddress, config.getSetting('xmrCmsKey', 'n/a'));
  });

  xmds.on('requiredFiles', async(data) => {
    console.debug('[Xmds::on("requiredFiles")] > Required Files', {
      registerDisplay: data,
      shouldParse: false,
    });

    // Start by saving the required files response, so we can replay it when we're offline.
    const libraryPath = config.getSetting('library');
    await fs.writeFile(
      join(libraryPath, 'requiredFiles.json'),
      JSON.stringify(data, null, 2),
    );

    // TODO: implement an Electron specific LibraryManager to keep track of and download these files.
    await Promise.all(data.files.map(async (file) => {

      // Download it.
      if (file.download == 'http') {
        console.log('[Xmds::on("requiredFiles")] > Downloading: ' + file.saveAs)
        return await downloadFile(file);
      } else if (file.type === 'resource') {
        const resourceHtml = await xmds.getResource(file);
        return await downloadResourceFile(file, resourceHtml);
      } else {
        return;
      }
    }));

    // Print all downloaded files
    const downloadedFiles = await getDownloadedFiles();
    console.log('[Xmds::on("requiredFiles")] > Downloaded files: ', {
      downloadedFiles,
    });
  });

  xmds.on('schedule', (data) => {
    schedule = data;
    console.debug('[Xmds::on("schedule")] > Schedule', {
      schedule: data,
      shouldParse: false,
    });

    // Update schedule of ScheduleManager
    
    // New schedule from XMDS, update the schedule manager
    manager.update(schedule).then(() => {
      console.debug('>>>> XLR.debug Schedule updated', schedule);
      manager.isAssessing = false;
    });
  });
  
  xmds.getSchemaVersion().then((version) => {
    config.xmdsVersion = version;
    
    xmds.start(config.getSetting('collectionInterval', 60));
  });
};

const init = (win) => {
  // Configure IPC
  configureIpc(win);

  // TODO: Configure a new folder for local files.
  configureFileManager();

  // Create a new Faults object
  // initializeFaults();

  // Create a new Config object
  const config = new Config(app, process.platform, state);
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
      
      // Bind event handlers
      await initXmrEventHandlers();
      await initXmdsEventHandlers();

      manager = new ScheduleManager(schedule);

      manager.on('layouts', async (layouts) => {
        console.debug({
          method: 'manager::layouts',
          message: 'updated layout loop received with ' + layouts.length + ' layouts'
        });

        if (schedule) {
          let scheduleLayouts =
            [...schedule.layouts, schedule.defaultLayout].reduce((arr: InputLayoutType[], item) => {
              const _layout = getLayoutFile(item.file);
              return [
                ...arr,
                {
                  layoutId: item.file,
                  response: item.response,
                  path: _layout.name,
                  shortPath: _layout.name,
                }
              ];
            }, []);

          win.webContents.send('update-unique-layouts', scheduleLayouts);
        }

        const _layouts = layouts.reduce((arr: InputLayoutType[], item) => {
          const layoutFile = getLayoutFile(item.file);

          return [
            ...arr,
            {
              layoutId: item.file,
              path: layoutFile?.name || '',
              shortPath: layoutFile?.name || '',
              response: item.response,
            },
          ]
        }, []);

        // Send updated layout loop to XLR
        win.webContents.send('update-loop', _layouts);
      });

      await manager.start(10);

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
    './dist/main/express.js' :
    join('./resources/app.asar', './dist/main/express.js');
  const redirectOutput = function(stream) {
    stream.on('data', (data) => {
      data.toString().split('\n').forEach((line) => {
        console.log(line);
      });
    });
  };


  const config = new Config(app, process.platform, state);
  createFileServer(config);

  console.log(expressPath);

  const expressAppProcess =
      spawn(appName, [expressPath], {env: {ELECTRON_RUN_AS_NODE: '1'}});
  [expressAppProcess.stdout, expressAppProcess.stderr].forEach(redirectOutput);
};

const configureFileManager = () => {
  ipcMain.handle('download-file', async (_event, file: RequiredFileType) => {
    await downloadFile(file);
    return getDownloadedFiles();
  });

  ipcMain.handle('get-files', async () => {
    return getDownloadedFiles();
  });
};

// const initializeFaults = () => {
//   const faults = new FaultsLib();
//   ipcMain.on('initFaults', (_events, faults) => {
//     console.debug('initializeFaults', {faults});
//   });
// };

app.whenReady().then(() => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' http://localhost:9696 data:; connect-src 'self' http://localhost:9696; frame-src 'self' http://localhost:9696; font-src 'self' http://localhost:9696 http://localhost data:;",
        ],
        'Access-Control-Allow-Origin': ['*'],  // Allow any domain to access
        'Access-Control-Allow-Methods': ['GET, POST, PUT, DELETE, OPTIONS'],  // Allowed methods
        'Access-Control-Allow-Headers': ['Content-Type, Authorization']  // Allowed headers
      }
    });
  });

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
