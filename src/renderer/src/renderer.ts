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
import './assets/fonts.css';
import './assets/main.css';
import '@xibosignage/xibo-layout-renderer/dist/styles.css';

import $ from 'jquery';
import XiboLayoutRenderer, {ConsumerPlatform, IXlr, OptionsType } from '@xibosignage/xibo-layout-renderer';
import DefaultLayout from './layout/defaultLayout';

// import { ConfigHandler } from '@renderer/ConfigHandler';
// import { loadConfig, registerConfigAdapter } from '@shared/console/ExtendedConsole';
// import { Config } from 'src/main/config/config';
import { ConfigHandler } from './ConfigHandler';
import { ConfigData } from '@shared/types';
// import { Xmds } from 'src/main/xmds/xmds';

let xlr: IXlr;

if (window.__extendedConsole) {
  (globalThis as any).console = window.__extendedConsole;
}

console.alert('Loading renderer process . . .');

// Setup broadcast channel listeners
const bc = new BroadcastChannel('statsBC');

bc.addEventListener('message', (event) => {
  const eventData = event.data;
  console.debug('[Renderer::BroadcastChannel:statsBC] Received event', event);
  window.electron.sendStatsBCMessage(eventData);
});

const runConfigHandler = async (config: ConfigData) => {
  const { callbackName } = await window.electron.requestCallback();
  const mainCallback = async (...args) => {
    return await window.electron.invokeCallback(callbackName, ...args);
  };

  // Show the configure view
  console.log('onConfigure: show configure view');
  const configHandler = new ConfigHandler(config, mainCallback);

  configHandler.init();

  // Run config
  await configHandler.run();
};

export const startApp = async () => {
  const config = await window.apiHandler.getConfig();

  const xlrOptions: Partial<OptionsType> = {
    appHost: 'http://localhost:9696/files/',
    platform: ConsumerPlatform.ELECTRON, // TODO: XLR should support "electron" as a type (as well as webOS, Tizen, etc)
    config: {
      cmsUrl: config.cmsUrl ?? window.location.origin,
      cmsKey: config.cmsKey ?? '',
      schemaVersion: config.xmdsVersion as number,
      hardwareKey: config.hardwareKey as string,
    },
    icons: {
      splashScreen: '/logo.png',
      logo: '/logo.png',
    },
  };
  
  // Create a splash screen
  const splash = new DefaultLayout();
  splash.path = '0.xlf';

  let layoutLoop = [splash];

  xlr = XiboLayoutRenderer(layoutLoop, xlrOptions as any);
  xlr.init().then((response: any) => {
    console.log('onConfigure: play schedules');
    console.log(response);
    xlr.playSchedules(response);
  });

  // Set global xlr for browser access
  window.xlr = xlr;
};

window.electron.onConfigure(async (config: ConfigData) => {
  console.log('onConfigure');
  window.config = config;

  if (!config.cmsUrl) {
    runConfigHandler(config);
  } else {
    startApp();
  }
});

window.electron.onStateChange((state) => {
  $('#status').html(state);
});

window.electron.onUpdateLoop((layouts) => {
  console.debug('[window.electron.onUpdateLoop]', { layouts });
  if (xlr) {
    console.debug('[window.electron.onUpdateLoop] > Emitting updateLoop to XLR');
    xlr.emitter.emit('updateLoop', layouts);
  }
});

window.electron.onUpdateUniqueLayouts(async layouts => {
  if (xlr) {
    console.log('[Renderer::onUpdateUniqueLayouts]', { layouts });
    await xlr.updateScheduleLayouts(layouts);
  }
});

const init = async () => {
  const config = await window.apiHandler.loadConfig();
  console.debug('[RENDERER] init > config', config);
  window.config = config;

  if (!config.isConfigured) {
    runConfigHandler(config);
  } else {
    const { callbackName } = await window.electron.requestCallback();
    const mainCallback = async (...args) => {
      return await window.electron.invokeCallback(callbackName, ...args);
    };

    // Run mainCallback
    await mainCallback({ context: 'renderer' });

    console.debug('[RENDERER] > startApp(): Called mainCallback');
    startApp();
  }
};

init();
