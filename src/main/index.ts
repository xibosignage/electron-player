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
import { app, shell, WebContentsView, BrowserWindow, ipcMain, session } from 'electron';
import { join } from 'path';
import { optimizer, is, electronApp } from '@electron-toolkit/utils';
import { Xmr } from '@xibosignage/xibo-communication-framework';
import axios from 'axios';
import 'dotenv/config';

import icon from '../../resources/icon.png?asset';
import { spawn } from 'child_process';
import { Config } from './config/config';
import { Xmds } from './xmds/xmds';
import { State } from './common/state';
import { createFileServer } from './express';
import { downloadFile, downloadResourceFile, getDownloadedFiles, getLayoutFile, FileManagerFileType } from './common/fileManager';
import Schedule from './xmds/response/schedule/schedule';
import ScheduleManager from './common/scheduleManager';
import { InputLayoutType, LocalFile } from './common/types';
import { ConsoleDB } from '../shared/console/ConsoleDB';
import { createExtendedConsole } from '../shared/console/ExtendedConsole';
import { PoPStats } from './common/stats/PoPStats';
import { submitStatXmlString } from './common/parser';
import { Layout } from './xmds/response/schedule/events/layout';
import { ConfigData, MainCallbackType } from '../shared/types';

// Axios interceptors
axios.interceptors.request.use(req => {
  console.log('[HTTP →]', {
    method: req.method,
    url: req.url,
    data: req.data,
    headers: req.headers,
  });
  return req;
});

axios.interceptors.response.use(
  res => {
    console.log('[HTTP ←]', {
      status: res.status,
      url: res.config.url,
      data: res.data,
    });
    return res;
  },
  err => {
    console.error('[HTTP ✖]', {
      message: err.message,
      code: err.code,
      url: err.config?.url,
      response: err.response,
    });
    return Promise.reject(err);
  }
);

const popStats = new PoPStats();
const db = new ConsoleDB();
const consoleMain = createExtendedConsole({ db, context: 'main' });

// Replace global console in main
(globalThis as any).console = consoleMain;

// Receive logs from renderer
ipcMain.handle('renderer-log', (_event, level: string, args: any) => {
  const fn = (consoleMain as any)[level] ?? consoleMain.log;
  fn('[RENDERER]', args);
});

let appConfig: ConfigData;
const state = new State();
export const config = new Config(app, process.platform, state);
state.width = 1280;
state.height = 720;

let xmds: Xmds;
let xmr: Xmr;
let schedule: Schedule;
let manager: ScheduleManager;

const loadConfig = async () => {
  await config.load();

  appConfig = JSON.parse(config.toJson());

  return appConfig;
};

// Register load config handler
ipcMain.handle('load-config', async (_event) => await loadConfig());

ipcMain.handle('get-config', async (_event) => appConfig);

// Bind to some events from the renderer for configuration.
ipcMain.handle('xmds-try-register', async (_event, _config) => {
  console.log('xmds-try-register: ', { _config });
  const configData = _config as ConfigData;
  config.cmsUrl = configData.cmsUrl;
  config.cmsKey = configData.cmsKey;
  config.displayName = configData.displayName;

  try {
    const xmds = new Xmds(config);

    const schemaVersion = await xmds.getSchemaVersion();
    if (schemaVersion <= 0) {
      return {success: false, error: "Cannot reach that URL"};
    }

    const xmdsRegister = await xmds.registerDisplay();

    return { success: true, data: xmdsRegister };
  } catch (err) {
    return {
      success: false,
      error: err,
    }
  }
});

const configureIpc = (win) => {
  ipcMain.on('open-child-window', (_event, url) => {
    const view = new WebContentsView();
    win.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
    view.webContents.loadURL(url);
  });

  // renderer requests a callback
  ipcMain.handle('request-callback', () => {
    return {
      callbackName: 'run',
    }
  });

  ipcMain.handle('invoke-callback', async (_event, { callbackName, args }) => {
    const fn = mainFunctions[callbackName];
    if (!fn) throw new Error(`No such main function: ${callbackName}`);
    return fn(...args);
  });

  ipcMain.on('stats-bc-message', (_event, payload) => {
    popStats.emitter.emit('message', payload);
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('stats-bc-message', payload);
    });
  });
};

const configureExpress = () => {
  // Start express
  const appName = app.getPath('exe');
  const expressPath = is.dev ?
    './dist/main/express.js' :
    join(process.resourcesPath, './app', './dist/main/express.js');
  const redirectOutput = function (stream) {
    stream.on('data', (data) => {
      data.toString().split('\n').forEach((line) => {
        console.log(line);
      });
    });
  };

  console.debug('[configureExpress]', {
    config,
    expressPath,
    appName,
  })
  createFileServer(config);

  console.log(expressPath);

  const expressAppProcess =
    spawn(
      appName, [
      '--inspect=8315',
      expressPath
    ], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
    );
  [expressAppProcess.stdout, expressAppProcess.stderr].forEach(redirectOutput);
};

const configureFileManager = () => {
  ipcMain.handle('download-file', async (_event, file: FileManagerFileType) => {
    await downloadFile(file);
    return getDownloadedFiles();
  });

  ipcMain.handle('get-files', async () => {
    return getDownloadedFiles();
  });
};

let mainWindow: BrowserWindow;
const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    frame: false,
    icon: icon,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webSecurity: true,
    },
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  mainWindow.setMenuBarVisibility(false);

  console.debug('[MAIN] > Loading renderer', {
    isDev: is.dev,
    ELECTRON_RENDERER_URL: process.env['ELECTRON_RENDERER_URL'],
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']).then(() => {
      init(mainWindow);
    });
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html')).then(() => {
      init(mainWindow);
    });
  }
};

const initXmrEventHandlers = async function () {
  // Bind to some XMR events
  xmr.on('connected', () => {
    console.log('XMR Connected');
  });
  xmr.on('collectNow', () => {
    console.debug('Requesting a collection immediately', { method: 'Xmr::screenShot' });
    xmds.collectNow();
  });
  xmr.on('screenShot', async () => {
    console.debug('Requesting a screenshot', { method: 'Xmr::screenShot' });
    await xmds.screenshot();
    await xmds.notifyStatus();
  });
  // xmr.on('licenceCheck', async () => {
  //   console.debug('Requesting a licence check', {method: 'Xmr::licenceCheck'});
  //   await config.checkLicence(true, 0);
  //   await xmds.notifyStatus();
  // });
  xmr.on('showStatusWindow', async (timeout) => {
    mainWindow.webContents.send('showStatusWindow', timeout);
  });
}

const initXmdsEventHandlers = async function (config: Config, xmr: Xmr) {
  // Bind to some events
  xmds.on('collecting', () => {
    console.debug('[Xmds::on("collecting")] > Collecting Data with collection interval ' +
      config.getSetting('collectionInterval', 60) + ' seconds'
    );
    console.debug('[Xmds::collecIntervalTime] ' + xmds.collectIntervalTime + ' seconds');
  });
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

  xmds.on('requiredFiles', async (data) => {
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

    // Set initial media inventory report
    await xmds.submitMediaInventory(
      await data.composeMediaInventory()
    );

    // TODO: implement an Electron specific LibraryManager to keep track of and download these files.
    await Promise.all(data.files.map(async (file) => {
      // Download it.
      if (file.download == 'http') {
        console.log('[Xmds::on("requiredFiles")] > Downloading: ' + file.saveAs)
        return await downloadFile((file as unknown) as FileManagerFileType);
      } else if (file.type === 'resource') {
        const resourceHtml = await xmds.getResource(file);
        return await downloadResourceFile((file as unknown) as FileManagerFileType, resourceHtml);
      } else {
        return null;
      }
    }));

    // Update media inventory as files are downloaded
    await xmds.submitMediaInventory(
      await data.composeMediaInventory(true),
    );
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
      console.debug('>>>> XLR.debug Schedule updated', { schedule });
      manager.isAssessing = false;
    });
  });

  xmds.on('submitLogs', async () => {
    console.debug('[Xmds::on("submitLogs")] > Submitting Logs');
    if (db) {
      console.debug('[Xmds::on("submitLogs")] > Database is available, submitting logs from DB');
      await xmds.submitLogs(db);
    }
  });

  xmds.on('submitStats', async () => {
    console.debug('[Xmds::on("submitStats")] > Submitting Stats');
    if (db) {
      console.debug('[Xmds::on("submitStats")] > Database is available, submitting stats from DB');

      const stats = popStats.getStats(50);

      if (stats.length === 0) {
        console.debug('[Xmds::submitStats] > No stats to submit');
        return;
      }

      let statsXmlString = '';
      stats.map((stat) => {
        statsXmlString += submitStatXmlString(stat);
      });

      xmds.submitStats(statsXmlString).then((success) => {

        console.debug('[Xmds::submitStats] Stats submitted to CMS');
        // If response succeeded, then delete pushed logs
        if (success) {
          console.log('Deleting pushed stats, count = ' + stats.length);

          popStats.clearSubmitted(stats);

          console.log('Deleted pushed stats');
        }
      });
    }
  });

  xmds.on('reportFaults', async () => {
    console.debug('[Xmds::on("reportFaults")] > Reporting Faults');
    await xmds.reportFaults();
  });
};

const mainFunctions = {
  run: async ({ context }: MainCallbackType) => {
    const win = mainWindow;
    // We are configured so continue starting the rest of the application.
    console.log('Configured.');

    if (!xmds) {
      // Configure XMDS
      xmds = new Xmds(config);

      await xmds.getSchemaVersion();

      // Put license checking here
    }

    // Configure XMR
    if (!xmr) {
      xmr = new Xmr(config.xmrChannel || 'unknown');
      // Initialize XMR
      await xmr.init();
    }

    // Bind event handlers
    await initXmrEventHandlers();
    await initXmdsEventHandlers(config, xmr);

    if (!manager) {
      manager = new ScheduleManager(schedule, config);

      manager.on('layouts', async (layouts) => {
        console.debug({
          method: 'manager::layouts',
          message: 'updated layout loop received with ' + layouts.length + ' layouts'
        });

        if (schedule) {
          let scheduleLayouts =
            [...schedule.layouts, schedule.defaultLayout].reduce((arr: InputLayoutType[], item) => {
              const _layout = getLayoutFile(item.file) as LocalFile;

              console.debug('[MAIN] manager.on("layouts") update-unique-layouts', {
                _layout,
                item,
              })

              let _collection = [...arr];

              if (_layout) {
                _collection = [
                  ...arr,
                  {
                    layoutId: item.file,
                    response: item.response,
                    path: _layout.name,
                    shortPath: _layout.name,
                    scheduleId: 'scheduleId' in item ? (item as Layout).scheduleId : -1,
                  }
                ];
              }

              return _collection;
            }, []);

          win.webContents.send('update-unique-layouts', scheduleLayouts);
        }

        const _layouts = layouts.reduce((arr: InputLayoutType[], item) => {
          const layoutFile = getLayoutFile(item.file) as LocalFile;
          let _collection = [...arr];

          console.debug('[MAIN] manager.on("layouts") update-loop', {
            layoutFile,
            item,
          })

          if (layoutFile) {
            _collection = [
              ...arr,
              {
                layoutId: item.file,
                path: layoutFile?.name || '',
                shortPath: layoutFile?.name || '',
                response: item.response,
                scheduleId: 'scheduleId' in item ? (item as Layout).scheduleId : -1,
              },
            ];
          }

          return _collection;
        }, []);

        console.debug('[MAIN::manager.on("layouts")] > Sending updated layout loop to renderer', { layouts: _layouts });
        // Send updated layout loop to XLR
        win.webContents.send('update-loop', _layouts);
      });

      await manager.start(10);
    }

    // Set up a regular status update push
    setInterval(() => {
      win.webContents.send('state-change', config.state.toHtml(config));
    }, 5000);

    xmds.start(config.getSetting('collectionInterval', 60));

    console.debug('[MAIN] mainFunctions.run() > context', context);
    // Start app through renderer
    if (context === 'main') {
      appConfig = JSON.parse(config.toJson());
      win.webContents.send('configure', appConfig);
    }

    console.debug('[MAIN::mainFunctions::run]', {
      config,
      appConfig,
    });

  }
};

const init = async (win: BrowserWindow) => {
  // Configure IPC
  configureIpc(win);

  // TODO: Configure a new folder for local files.
  configureFileManager();

  // Player API and static file serving
  configureExpress();

  appConfig = await loadConfig();

  // // eslint-disable-next-line max-len
  // console.log(`Version: ${appConfig.version}, hardwareKey: ${appConfig.hardwareKey}`);

  // console.debug('isConfigured', appConfig.isConfigured);
  // console.debug('[MAIN] init > config', appConfig);

  // // Are we configured?
  // if (!appConfig.isConfigured) {
  //   console.log('Not configured, showing configuration page');

  //   // Switch to the configuration page in the renderer.
  //   win.webContents.send('configure', appConfig);
  // } else {
  //   mainFunctions.run(win, config);
  // }
};

app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' http://localhost:9696 https://develop.xibo.co.uk data:; connect-src 'self' http://localhost:9696 https://auth.signlicence.co.uk; media-src 'self' http://localhost:9696; frame-src 'self' http://localhost:9696; font-src 'self' http://localhost:9696 http://localhost data:;",
        ],
        // 'Access-Control-Allow-Origin': ['http://localhost:5173'],  // Allow any domain to access
        'Access-Control-Allow-Methods': ['GET, POST, PUT, DELETE, OPTIONS'],  // Allowed methods
        'Access-Control-Allow-Headers': ['Content-Type, Authorization']  // Allowed headers
      }
    });
  });

  // Install dev tools extension.
  installExtension(JQUERY_DEBUGGER)
    .then((ext) => console.log(`Added Extension:  ${ext.name}`))
    .catch((err) => console.log('An error occurred: ', err));

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
