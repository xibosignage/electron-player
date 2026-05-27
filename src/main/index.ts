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
const { readFileSync } = require('fs');
import { installExtension, JQUERY_DEBUGGER } from 'electron-devtools-installer';
import { app, shell, WebContentsView, BrowserWindow, ipcMain, session, screen } from 'electron';
import { join } from 'path';
import { optimizer, is, electronApp } from '@electron-toolkit/utils';
import { Xmr } from '@xibosignage/xibo-communication-framework';
import axios from 'axios';
import 'dotenv/config';
import { DateTime } from 'luxon';
import os from 'os';
import { IXlrEvents } from '@xibosignage/xibo-layout-renderer';
import { monitorEventLoopDelay } from 'perf_hooks';

import icon from '../../resources/icon.png?asset';
import { spawn } from 'child_process';
import { Config } from './config/config';
import { Xmds } from './xmds/xmds';
import { State } from './common/state';
import { createFileServer } from './express';
import {
  downloadFile,
  downloadResourceFile,
  getDownloadedFiles,
  getLayoutFile,
  FileManagerFileType,
  downloadWidgetDataFile,
  getWidgetFile,
  purge,
  purgeAll,
  isPurging,
  setIsPurging,
  findLayoutFileByCode,
} from './common/fileManager';
import Schedule from './xmds/response/schedule/schedule';
import ScheduleManager from './common/scheduleManager';
import { InputLayoutType, LocalFile, RequiredFile } from './common/types';
import { ConsoleDB } from '../shared/console/ConsoleDB';
import { createExtendedConsole, registerConfigAdapter } from '../shared/console/ExtendedConsole';
import { PoPStats } from './common/stats/PoPStats';
import { submitStatXmlString } from './common/parser';
import { Layout } from './xmds/response/schedule/events/layout';
import { ConfigData, MainCallbackType } from '../shared/types';
import { commandManager } from '../shared/command/commandManager';
import { registerLocalCommands } from './command/localCommands';
import { scheduleCriteriaManager } from '../shared/scheduleCriteria/scheduleCriteriaManager';
import { geoLocationManager } from './common/geoLocationManager';
import { xmdsMakeScreenshot } from '../shared/utils/xmdsUtil';
import { DefaultLayout } from './xmds/response/schedule/events/defaultLayout';
import { OverlayLayout } from './xmds/response/schedule/events/overlayLayout';
import { Faults } from '../shared/faults/Faults';
import Ssp from './common/ssp';
import SspLayout from './xmds/response/schedule/events/sspLayout';

/**
 * Extract the layout `code` attribute from an XLF file without fully parsing it.
 * Returns undefined if the file cannot be read or does not contain a code attribute.
 * Used to pre-populate InputLayoutType.code so navLayout can match by code without
 * fetching and parsing every XLF at runtime.
 */
function extractLayoutCode(localPath: string): string | undefined {
  try {
    const content: string = readFileSync(localPath, 'utf-8');
    const match = content.match(/\bcode="([^"]*)"/);
    return match?.[1] || undefined;
  } catch {
    return undefined;
  }
}

// Passive event-loop lag monitor — logs a warning whenever the main thread is
// blocked for more than 50 ms. Helps verify that sync-I/O fixes are working.
const elMonitor = monitorEventLoopDelay({ resolution: 10 });
elMonitor.enable();
setInterval(() => {
  const maxMs = elMonitor.max / 1e6;
  if (maxMs > 50) {
    console.warn(`[EL-LAG] Main process blocked for ${maxMs.toFixed(0)} ms in the last 10 s`);
  }
  elMonitor.reset();
}, 10_000);

// Axios interceptors
axios.interceptors.request.use(req => {
  console.log('[HTTP →]', { method: req.method, url: req.url });
  return req;
});

axios.interceptors.response.use(
  res => {
    console.log('[HTTP ←]', { status: res.status, url: res.config.url });
    return res;
  },
  err => {
    // Log only metadata — never the response body, which can be large XML.
    console.error('[HTTP ✖]', {
      message: err.message,
      code: err.code,
      url: err.config?.url,
      status: err.response?.status,
    });
    return Promise.reject(err);
  }
);

const popStats = new PoPStats();
const db = new ConsoleDB();
const consoleMain = createExtendedConsole({
  db,
  context: 'main',
  getLogLevel: () => config.getSetting('logLevel', 'error'),
});
const faults = new Faults(db);

// Replace global console in main
(globalThis as any).console = consoleMain;

// Receive logs from renderer
ipcMain.handle('renderer-log', (_event, level: string, args: any) => {
  const fn = (consoleMain as any)[level] ?? consoleMain.log;
  fn('[RENDERER]', args);
});

let appConfig: ConfigData;
let statusWindowVisible = false;
const state = new State();
export const config = new Config(app, process.platform, state);
registerConfigAdapter({ getConfig: () => JSON.parse(config.toJson()) });
state.width = 1280;
state.height = 720;

// Populate LAN IP from the device's network interfaces
const lanIp = Object.values(os.networkInterfaces())
  .flat()
  .find(iface => iface?.family === 'IPv4' && !iface.internal);
state.lanIpAddress = lanIp?.address ?? '';

// Keep state in sync whenever the geolocation manager accepts a new location
geoLocationManager.on('geoLocationUpdated', () => {
  const { latitude, longitude } = geoLocationManager.getCurrentLocation();
  console.debug('[MAIN] geoLocationUpdated event received', {
    latitude,
    longitude,
  });
  if (latitude !== null) state.latitude = latitude;
  if (longitude !== null) state.longitude = longitude;
});

let xmds: Xmds;
let xmr: Xmr;
let schedule: Schedule;
let manager: ScheduleManager;
let ssp: Ssp;
let pendingScheduleRefresh = false;

const loadConfig = async () => {
  console._log('[MAIN] > Loading config started');
  const t = Date.now();
  await config.load();

  console._log(`[MAIN] > Loading config finished in ${Date.now() - t}ms`);

  appConfig = JSON.parse(config.toJson());

  if (appConfig && typeof appConfig.state === 'string') {
    appConfig.state = JSON.parse(appConfig.state);
  }

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

ipcMain.handle('ssp-get-ad', async () => {
  console.debug('[MAIN][ssp-get-ad] SSP ad requested from renderer', {
    ssp,
  });
  if (!ssp) return null;
  const sspAd = await ssp.getAd();
  console._log('[MAIN][ssp-get-ad] SSP ad generated', { sspAd });
  if (!sspAd) return null;
  return sspAd;
});

ipcMain.handle('ssp-report-impression', async (_event, { urls, duration, lat, lng }: { urls: string[], duration: number, lat: number | null, lng: number | null }) => {
  console.debug('[MAIN][ssp-report-impression] Reporting SSP impression', { urls, duration, lat, lng });
  if (!ssp) return;
  await ssp.reportImpression(urls, duration, DateTime.now(), lat, lng);
});

ipcMain.handle('ssp-report-error', async (_event, { urls, code }: { urls: string[], code: number }) => {
  console.debug('[MAIN][ssp-report-error] Reporting SSP error', { urls, code });
  if (!ssp) return;
  await ssp.reportError(urls, code);
});

ipcMain.handle('ssp-get-widget-ad', async (_event, partnerId: string) => {
  console.debug('[MAIN][ssp-get-widget-ad] SSP widget ad requested', { partnerId });
  if (!ssp) return null;
  return ssp.getWidgetAd(partnerId);
});

ipcMain.handle('ssp-report-widget-impression', async (_event, urls: string[], duration: number) => {
  console.debug('[MAIN][ssp-report-widget-impression] Reporting SSP widget impression', { urls, duration });
  if (!ssp) return;
  await ssp.reportWidgetImpression(urls, duration);
});

ipcMain.handle('find-layout-by-code', async (_event, code: string) => {
  return findLayoutFileByCode(code);
});

ipcMain.handle('execute-xlr-event', async (_event, { eventName, payload }: { eventName: keyof IXlrEvents, payload: any }) => {
  console.debug(`[MAIN] [execute-xlr-event] > Executing XLR event from renderer`, {
    eventName,
    payload
  });

  if (eventName === 'layoutStart') {
    state.currentLayoutId = payload.layoutId;

    if (Object.hasOwn(config.settings, 'sendCurrentLayoutAsStatusUpdate') &&
      config.settings.sendCurrentLayoutAsStatusUpdate === true
    ) {
      console.debug('[MAIN] [XLR::on("layoutStart")] > Sending current layout as status update to CMS', {
        layoutId: state.currentLayoutId,
      });

      await xmds.notifyStatus(['currentLayoutId']);
    }
  } else if (eventName === 'layoutEnd' || eventName === 'overlayEnd') {
    if (manager) {
      await manager.incrementPlayCount(payload.scheduleId);
      console.debug(`[MAIN] [execute-xlr-event] > Play count incremented`, {
        event: eventName,
        scheduleId: payload.scheduleId,
        playStats: manager.getPlayStats(payload.scheduleId),
      });
    }
  } else if (eventName === 'commandCodeReceived') {
    // Handle command code received event
    await commandManager.executeCommandByCode(payload.commandCode);
  } else if (eventName === 'commandStringReceived') {
    // Handle command string received event
    await commandManager.executeCommandByString(payload.commandString);
  }
});

// Collects all status-window data and pushes the rendered HTML to the renderer.
// Called both by the 5-second interval (while visible) and immediately when the
// window is first shown, so the window is never blank on open.
const collectAndPushStatus = async (win: BrowserWindow) => {
  config.state.activeFaults = faults.getActiveFaults();
  config.state.pendingStatsCount = popStats.getCount();
  config.state.pendingLogsCount = db.count();

  const rawCriteria = scheduleCriteriaManager.getActiveCriteria();
  config.state.activeCriteria = Object.fromEntries(
    Object.entries(rawCriteria).map(([key, entry]) => [key, {
      metric: entry.metric,
      value: entry.value,
      ttl: entry.ttl,
    }])
  );

  config.state.recentLogs = db.getRecentLogs(5).map(l => ({
    level: l.level ?? '',
    message: l.message ?? '',
    timestamp: l.timestamp ?? 0,
  }));

  try {
    const diskStats = await fs.statfs(config.getSetting('library'));
    config.state.totalSpace = diskStats.bsize * diskStats.blocks;
    config.state.availableSpace = diskStats.bsize * diskStats.bavail;
  } catch (err) {
    console.warn('[MAIN] Could not read disk stats:', err);
  }

  win.webContents.send('state-change', config.state.toHtml());
};

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

  ipcMain.on('report-fault', (_event, faultData) => {
    console.debug('[MAIN] report-fault event received', faultData);
    faults.emitter.emit('message', faultData);
  });

  ipcMain.on('status-window-visibility', (_event, visible: boolean) => {
    statusWindowVisible = visible;
    if (visible) {
      // Push immediately so the window isn't blank while waiting for the first interval tick.
      collectAndPushStatus(win);
    }
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
    fullscreen: true,
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
    await xmdsMakeScreenshot(xmds);
    await xmds.notifyStatus();
  });

  /**
   * Clears stats and logs from database.
   */
  xmr.on('clearStatsAndLogs', async () => {
    console.debug('[XMR::clearStatsAndLogs] Clearing stats and Logs from local database');

    db.deleteAllLogs();
    popStats.clearDB();
  });
  
  /**
   * Handle incoming schedule criteria updates from the CMS via XMR.
   * This includes updates that originated from the API before being relayed by the CMS.
   */
  xmr.on('criteriaUpdate', async (criteriaUpdates) => {
    for (const criteria of criteriaUpdates) {
      const { metric, value, ttl } = criteria;
      scheduleCriteriaManager.addOrReplace(metric, value, ttl);
    }
    console.log('[XMR::criteriaUpdate] - New criteria updates added', criteriaUpdates);
  });

  /**
   * Handles an incoming command identified by a CMS-provided command code.
   */
  xmr.on('commandCodeReceived', async (commandCode) => {
    console.log('[Xmr::commandCodeReceived] - Received a new command', commandCode);
    await commandManager.executeCommandByCode(commandCode);
  });

  /**
   * @TODO: This will have a different implementation since required files are stored locally
   * 
   * Handles `dataUpdate` messages and forces the widget data to be downloaded and cached.
   */
  xmr.on('dataUpdate', async (widgetId) => {
    console.debug('[XMR::dataUpdate] Updating widget data file', widgetId);

    const widgetData = await xmds.getData(`${widgetId}`);

    if (!widgetData) {
      console.debug('[XMR::dataUpdate] No widget data received for widget ' + widgetId);
      return;
    }

    const widgetLocalFile = getWidgetFile(widgetId);

    if (widgetLocalFile === null) {
      // No local file yet — download fresh (e.g. widget data cache not ready during requiredFiles processing).
      console.debug('[XMR::dataUpdate] No local file found, downloading fresh for widget ' + widgetId);
      await downloadWidgetDataFile({
        id: `${widgetId}`,
        type: 'widget',
      } as FileManagerFileType, widgetData, 'success');

      return;
    }

    console.debug('[XMR::dataUpdate] Received widget data for widget ' + widgetId, { widgetData });

    await downloadWidgetDataFile({
      id: `${widgetId}`,
      type: 'widget',
    } as FileManagerFileType, widgetData, 'updated');
  });

  /**
   * Handles `purgeAll` event by clearing all files from the local library directory and their
   * database records, then immediately requests a fresh required files list from the CMS.
   */
  xmr.on('purgeAll', async () => {
    // Flag purge as in-progress before the transition delay begins
    setIsPurging(true);

    try {
      // Push splash screen so XLR transitions away from the current layout before files are deleted
      if (manager) {
        manager.layouts = [manager.getSplash()];
        manager.emitter.emit('layouts', [manager.getSplash()]);
        console.debug('[XMR::purgeAll] Changed to splash screen');
      }

      // Give XLR time to switch to the splash screen before wiping the library
      await new Promise(resolve => setTimeout(resolve, 10000));

      console.debug('[XMR::purgeAll] clearing local library');
      await purgeAll();

      // Reset CRC cache so collect() forces a full re-fetch of requiredFiles and schedule.
      // Without this, collectNow() passes the old CRCs and both requests are skipped.
      xmds.checkRf = null;
      xmds.checkSchedule = null;
      pendingScheduleRefresh = true;

      await xmds.collectNow();
    } finally {
      setIsPurging(false);
    }
  });
}

async function dataWidgetUpdate(file: RequiredFile) {
  console.debug('[MAIN] [dataWidgetUpdate] > Updating widget data file for widget ' + file.id);
  const widgetData = await xmds.getData(file.id);

  if (!widgetData) {
    console.debug('[MAIN] [dataWidgetUpdate] > No widget data received for widget ' + file.id);
    return;
  }

  console.debug('[MAIN] [dataWidgetUpdate] > Received updated widget data for widget ' + file.id, { widgetData });

  return await downloadWidgetDataFile((file as unknown) as FileManagerFileType, widgetData, 'updated');
}

let screenshotIntervalId: NodeJS.Timeout | null = null;
const initXmdsEventHandlers = async function (config: Config, xmr: Xmr) {
  // Bind to some events
  xmds.on('collecting', () => {
    console.debug('[Xmds::on("collecting")] > Collecting Data with collection interval ' +
      config.getSetting('collectionInterval', 60) + ' seconds'
    );
    console.debug('[Xmds::collecIntervalTime] ' + xmds.collectIntervalTime + ' seconds');
  });
  xmds.on('registered', async (data) => {
    console.debug('[Xmds::on("registered")] > Registered', {
      registerDisplay: data,
      shouldParse: false,
    });

    await config.setConfig(data);

    // Configure SSP now that we have the updated settings (isSspEnabled, hardwareKey)
    if (ssp) {
      ssp.configure(
        config.getSetting('isSspEnabled', false),
        config.cmsUrl || '',
        config.hardwareKey || null,
      );
    }

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
    
    const makeScreenshot = async () => {
      await xmdsMakeScreenshot(xmds);
      await xmds.notifyStatus();
    };
    const screenshotRequested = data.getSetting('screenShotRequested', 0);
    console.debug('[Xmds::on("registered")] > screenShotRequested', screenshotRequested);
    // Is there a screenshot request pending which we may have missed via XMR?
    if (screenshotRequested === 1) {
      console.debug('[Xmds::on("registered")] > Pending screenshot request found, capturing desktop and taking screenshot');

      // Wait a bit and process it
      setTimeout(async () => {
        await makeScreenshot();
      }, 1000);
    }

    const screenshotInterval = data.getSetting('screenShotRequestInterval', 0) as number;
    console.debug('[Xmds::on("registered")] > screenShotRequestInterval', {
      screenshotInterval,
      screenshotIntervalId,
    });

    if (screenshotInterval === 0 && screenshotIntervalId !== null) {
      console.debug('[Xmds::on("registered")] > Clearing existing screenshot interval before applying new one', {
        screenshotIntervalId,
      });
      clearInterval(screenshotIntervalId);
    }

    const handleIntervalScreenshot = () => {
      const screenshotIntervalInMinutes = (screenshotInterval * 60);
      screenshotIntervalId = setInterval(async () => {
        console.debug('[Xmds::on("registered")] > Regular screenshot request interval triggered, capturing desktop and taking screenshot', {
          screenshotIntervalInMinutes: screenshotInterval,
        });

        await makeScreenshot();
      }, screenshotIntervalInMinutes * 1000)
    };

    if (screenshotInterval > 0) {
      handleIntervalScreenshot();
    }
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
    // Skip if 'purgeAll' is in progress
    if (!isPurging) {
      await Promise.all(data.files.map(async (file) => {
        // Skip if 'purgeAll' is in progress mid-iteration
        if (isPurging) {
          console.debug('[Xmds::on("requiredFiles")] > Skip downloading: ' + file.saveAs + ', purgeAll is in progress.');
          return null;
        }

        // Download it.
        if (file.download == 'http') {
          console.log('[Xmds::on("requiredFiles")] > Downloading: ' + file.saveAs)
          return await downloadFile((file as unknown) as FileManagerFileType);
        } else if (file.type === 'resource') {
          const resourceHtml = await xmds.getResource(file);
          return await downloadResourceFile((file as unknown) as FileManagerFileType, resourceHtml);
        } else if (file.type === 'widget') {
          return dataWidgetUpdate(file);
        } else {
          return null;
        }
      }));
    }

    // After a purge all, re-emit the schedule event so update-unique-layouts is re-sent with
    // correct paths now that files are back in the DB and are downloaded in local libraries.
    if (pendingScheduleRefresh) {
      pendingScheduleRefresh = false;
      if (schedule) {
        xmds.emitter.emit('schedule', schedule);
      }
    }

    // After all files have been processed, keep track of widget files and set up regular updates for them if required based on the updateInterval property.
    data.updateDataWidgets(async (file) => {
      await dataWidgetUpdate(file);
    });

    // Update media inventory as files are downloaded
    await xmds.submitMediaInventory(
      await data.composeMediaInventory(true),
    );

    // Clean up files marked for purge
    if (data.purge?.length) {
      console.debug('[Xmds::on("requiredFiles")] purge list received', {
        purgeCount: data.purge.length,
        purgeItems: data.purge.map(p => p.storedAs),
        method: 'XMDS::requiredFiles',
      });
      purge(data.purge);
    }

    // Count how many of the required files are present in local storage
    const inventory = getDownloadedFiles();
    const inventoryNames = new Set(inventory.map(f => (f as { name: string }).name));
    config.state.requiredFilesCount = data.files.length;

    // Each file type is stored under a different name in the DB. Find which ones are not yet present
    const missingFiles = data.files.filter(file => {
      if (file.type === 'resource') {
        return !inventoryNames.has(`layout_${file.layoutId}_region_${file.regionId}_media_${file.mediaId}.html`);
      }
      if (file.type === 'widget') return !inventoryNames.has(`${file.id}.json`);
      return !inventoryNames.has(file.saveAs ?? '');
    });
    
    config.state.downloadedFilesCount = data.files.length - missingFiles.length;

    // Use the same filename that was looked up in the inventory so the name is meaningful
    config.state.missingFiles = missingFiles.map(file => {
      if (file.type === 'resource') return `layout_${file.layoutId}_region_${file.regionId}_media_${file.mediaId}.html`;
      if (file.type === 'widget') return `${file.id}.json`;
      return file.saveAs ?? `${file.type}:${file.id}`;
    });
  });

  xmds.on('schedule', async (data) => {
    schedule = data;
    console.debug('[Xmds::on("schedule")] > Schedule', {
      schedule: data,
      shouldParse: false,
    });

    // Update schedule of ScheduleManager
    let scheduleLayouts =
      [...schedule.layouts, schedule.defaultLayout, ...schedule.overlays]
        .reduce((arr: InputLayoutType[], item: Layout | DefaultLayout | OverlayLayout | SspLayout) => {
          // SSP layout: no file on disk, send a placeholder so XLR can fire adRequest
          if (item instanceof SspLayout) {
            const sspLayoutItem = item as SspLayout;

            return [...arr, sspLayoutItem];
          }

          const _layout = getLayoutFile(item.file) as LocalFile;

          let _collection = [...arr];

          if (_layout) {
            const layoutItem: InputLayoutType = {
              layoutId: item.file,
              response: item.response,
              path: _layout.name,
              shortPath: _layout.name,
              scheduleId: 'scheduleId' in item ? (item as Layout).scheduleId : -1,
              shareOfVoice: 'shareOfVoice' in item ? (item as (Layout | OverlayLayout | SspLayout)).shareOfVoice : 0,
              code: _layout.localPath ? extractLayoutCode(_layout.localPath) : undefined,
            };

            if (item instanceof OverlayLayout || 'isOverlay' in item) {
              layoutItem.isOverlay = item.isOverlay as boolean;
            }

            _collection = [
              ...arr,
              layoutItem,
            ];
          }

          return _collection;
        }, []);

    mainWindow.webContents.send('update-unique-layouts', scheduleLayouts);

    // New schedule from XMDS, update the schedule manager
    manager.update(schedule).then(() => {
      console.debug('>>>> XLR.debug Schedule updated', { schedule });
      manager.isAssessing = false;
    });

    // Check if the current schedule contains any weather-based criteria.
    // If found, enable the weather flag so XMDS fetches weather updates
    // automatically on the next collection interval.
    const hasWeatherCriteria = schedule.layouts.some((layout: any) =>
      Array.isArray(layout.criteria) &&
      layout.criteria.some((c: any) => c.type === 'weather')
    );
    xmds.setGetWeatherData(hasWeatherCriteria);
    
    // Schedule time-based commands from the CMS schedule, if any
    const validScheduledCommands = await manager.assessCommands();

    commandManager.scheduleCommands(validScheduledCommands);
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
          console.log('[Xmds::submitStats] Deleting pushed stats, count = ' + stats.length);

          popStats.clearSubmitted(stats);

          console.log('[Xmds::submitStats] Deleted pushed stats');
        }
      });
    }
  });

  /**
   * Handles incoming weather criteria updates received from the CMS via XMDS.
   * These updates are stored locally with a TTL slightly longer than the collection interval.
   */
  xmds.on('weatherCriteriaUpdates', async (criteriaUpdates: Record<string, any>) => {
    // Add a TTL slightly longer (+30 seconds) than the collection interval
    const ttl = (xmds.collectIntervalTime ?? 300) + 30;

    for (const [metric, value] of Object.entries(criteriaUpdates)) {
      scheduleCriteriaManager.addOrReplace(metric, value, ttl)
    }
    console.log('[Xmds::weatherCriteriaUpdates] - New weather criteria updates added', {criteriaUpdates});
  })

  let isReportingFaults = false;
  xmds.on('reportFaults', async () => {
    if (isReportingFaults) return;
    isReportingFaults = true;
    try {
      console.debug('[Xmds::on("reportFaults")] > Reporting Faults');
      await xmds.reportFaults(faults.toJson());
    } finally {
      isReportingFaults = false;
    }
  });

  xmds.on('collected', () => {
    config.state.nextScheduleUpdate = DateTime.now().plus({ seconds: xmds.collectIntervalTime });
  });
};

const initSspEventHandlers = async function () {
  if (ssp) {
    ssp.on('shareOfVoiceChanged', async (shareOfVoice, averageDuration) => {
      if (manager) {
        await manager.updateSspSov(shareOfVoice, averageDuration);
      }
    });
  }
}

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

    // Initialize SSP if enabled in settings
    if (!ssp) {
      ssp = new Ssp(config);
    }

    if (!manager) {
      manager = new ScheduleManager(schedule, config);

      manager.on('layouts', async (layouts) => {
        console.debug({
          method: 'manager::layouts',
          message: 'updated layout loop received with ' + layouts.length + ' layouts'
        });

        const _layouts = layouts.reduce((arr: InputLayoutType[], item) => {
          // SSP layout: no file on disk, send a placeholder so XLR can fire adRequest
          if (item instanceof SspLayout) {
            const sspLayoutItem = item as SspLayout;

            return [...arr, sspLayoutItem];
          }

          // Splash screen has no DB record, pass it directly so XLR receives `layoutId: 0`
          if (item.file === 0) {
            return [...arr, {
              layoutId: 0,
              path: '0.xlf',
              shortPath: '0.xlf',
              response: item.response ?? '',
              scheduleId: -1,
            }];
          }

          const layoutFile = getLayoutFile(item.file) as LocalFile;
          let _collection = [...arr];

          if (layoutFile) {
            _collection = [
              ...arr,
              {
                layoutId: item.file,
                path: layoutFile?.name || '',
                shortPath: layoutFile?.name || '',
                response: item.response ?? '',
                scheduleId: 'scheduleId' in item ? (item as Layout).scheduleId : -1,
                code: layoutFile.localPath ? extractLayoutCode(layoutFile.localPath) : undefined,
              },
            ];
          }

          return _collection;
        }, []);

        console.debug('[MAIN::manager.on("layouts")] > Sending updated layout loop to renderer', { layouts: _layouts });
        // Send updated layout loop to XLR
        win.webContents.send('update-loop', _layouts);
      });

      manager.on('overlays', async (overlays) => {
        console.debug({
          method: 'manager::overlays',
          message: 'updated overlay loop received with ' + overlays.length + ' overlays'
        });
        
        const _overlays = overlays.reduce((arr: InputLayoutType[], item) => {
          const layoutFile = getLayoutFile(item.file) as LocalFile;
          let _collection = [...arr];

          console.debug('[MAIN] manager.on("overlays") update-overlays', {
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
                response: item.response ?? '',
                scheduleId: 'scheduleId' in item ? (item as Layout).scheduleId : -1,
                isOverlay: item.isOverlay,
              },
            ];
          }

          return _collection;
        }, []);

        // Send updated overlay loop to XLR
        win.webContents.send('update-overlays', _overlays);
      });

      await manager.start(10);
    }

    // Register local commands
    await registerLocalCommands({
      xmds,
      win,
    });

    // Bind event handlers
    await initXmrEventHandlers();
    await initXmdsEventHandlers(config, xmr);
    await initSspEventHandlers();

    // Delete faults on app start/reboot
    faults.clearDB('MAIN');

    // Periodically check for expired faults and delete it
    faults.clear();

    // Refresh the status window every 5 seconds while it is open.
    // collectAndPushStatus is also called immediately when the window is shown,
    // so the first render is never blank.
    setInterval(async () => {
      if (!statusWindowVisible) return;
      await collectAndPushStatus(win);
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
  state.version = config.version ?? '';
  state.cmsUrl = config.cmsUrl ?? '';
  state.deviceName = config.displayName ?? '';

  // Start resolving the device's location via IP geolocation
  geoLocationManager.start();

  console.debug('[MAIN] init > config', {
    config,
    appConfig,
  });

  // Set window to fullscreen
  // If dimension and position settings are all "0"
  if (config.settings.offsetX === 0 &&
    config.settings.offsetY === 0 &&
    config.settings.sizeX === 0 &&
    config.settings.sizeY === 0) {
    console.debug('[MAIN] init > No offset or size settings, setting window to fullscreen');
    // Set window to fullscreen
    win.setFullScreen(true);
    const { width, height } = screen.getPrimaryDisplay().size;
    state.width = width;
    state.height = height;
  } else {
    // Otherwise, set the window to the specified dimensions and position.
    const offsetX = config.settings.offsetX ?? 0;
    const offsetY = config.settings.offsetY ?? 0;
    const sizeX = config.settings.sizeX || config.state.width;
    const sizeY = config.settings.sizeY || config.state.height;

    console.debug('[MAIN] init > Setting window to custom dimensions and position', {
      offsetX,
      offsetY,
      sizeX,
      sizeY,
    });
    win.setSize(sizeX, sizeY);
    win.setPosition(offsetX, offsetY);
    state.width = sizeX;
    state.height = sizeY;
  }

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
          "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' http://localhost:9696 https://develop.xibo.co.uk data: https:; connect-src 'self' http://localhost:9696 https://auth.signlicence.co.uk; media-src 'self' http://localhost:9696 https:; frame-src 'self' http://localhost:9696; font-src 'self' http://localhost:9696 http://localhost data:;",
        ],
        // 'Access-Control-Allow-Origin': ['http://localhost:5173'],  // Allow any domain to access
        'Access-Control-Allow-Methods': ['GET, POST, PUT, DELETE, OPTIONS'],  // Allowed methods
        'Access-Control-Allow-Headers': ['Content-Type, Authorization', 'x-preview-jwt']  // Allowed headers
      }
    });
  });
  session.defaultSession.setPermissionRequestHandler((_, permission, callback) => {
    if (permission === 'geolocation') {
      callback(true); // Approve geolocation permission requests
    } else {
      callback(false); // Deny all other permission requests
    }
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
