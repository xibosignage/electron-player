/*
 * Copyright (c) 2024 Xibo Signage Ltd
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
import {app, shell, BrowserView, BrowserWindow, ipcMain} from 'electron';
import {join} from 'path';
import {optimizer, is} from '@electron-toolkit/utils';
import icon from '../../resources/icon.png?asset';
import {spawn} from 'child_process';
import {Config} from './config/config';

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
  // Create a new Config object
  const config = new Config(app.getPath('userData'), process.platform);
  config.load().then(() => {
    // eslint-disable-next-line max-len
    console.log(`Version: ${config.version}, hardwareKey: ${config.hardwareKey}`);

    // Are we configured?
    if (!config.isConfigured()) {
      console.log('Not configured, showing configuration page');

      // Switch to the configuration page in the renderer.
      win.webContents.send('show-configure', config);
    }

    configureIpc(win);

    // We are configured so continue starting the rest of the application.
    // Player API and static file serving
    configureExpress();
  });
};

const configureIpc = (win) => {
  ipcMain.on('open-child-window', (_event, url) => {
    const view = new BrowserView();
    win.addBrowserView(view);
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


