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
import XiboLayoutRenderer, { ConsumerPlatform, IXlr, OptionsType } from '@xibosignage/xibo-layout-renderer';
import DefaultLayout from './layout/defaultLayout';

import { ConfigHandler } from './ConfigHandler';
import { ConfigData } from '@shared/types';
import { commandManager } from '@shared/command/commandManager';
import logo from './assets/images/logo.png';

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
  window.playerAPI.sendStatsBCMessage(eventData);
});

const runConfigHandler = async (config: ConfigData) => {
  const { callbackName } = await window.playerAPI.requestCallback();
  const mainCallback = async (...args) => {
    return await window.playerAPI.invokeCallback(callbackName, ...args);
  };

  // Show the configure view
  console.log('onConfigure: show configure view');
  const configHandler = new ConfigHandler(config, mainCallback);

  configHandler.init();

  // Run config
  await configHandler.run();
};

const initXlrEventHandlers = function () {
  // TODO: implement an ad request in XLR.
  // xlr.on('adRequest', async (sspLayoutIndex: number) => {
  //   const sspLayout = await ssp.getAd();
  //   xlr.updateInputLayout(sspLayoutIndex, (sspLayout as unknown) as InputLayoutType);
  // });

  /**
   * Handles an incoming command identified by a CMS-provided command code.
   */
  xlr.on('commandCodeReceived', async (commandCode) => {
    console.log('[Xmr::commandCodeReceived] - Received a new command', commandCode);
    await commandManager.executeCommandByCode(commandCode);
  });

  /**
   * Handles an incoming command provided as an encoded command string.
   */
  xlr.on('commandStringReceived', async (commandString) => {
    console.log('[Xmr::commandStringReceived] - Received a new command', commandString);
    await commandManager.executeCommandByString(commandString);
  });
}

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
      splashScreen: logo,
      logo: logo,
    },
  };

  // Create a splash screen
  const splash = new DefaultLayout();
  splash.path = '0.xlf';

  let layoutLoop = [splash];

  xlr = XiboLayoutRenderer(layoutLoop, [], xlrOptions as any);
  xlr.init().then(async (response: any) => {
    console.log('onConfigure: play schedules');
    console.log(response);

    initXlrEventHandlers();
    await xlr.playSchedules(response);
  });

  // Set global xlr for browser access
  window.xlr = xlr;
};

window.playerAPI.onConfigure(async (config: ConfigData) => {
  console.log('onConfigure');
  window.config = config;

  if (!config.cmsUrl) {
    runConfigHandler(config);
  } else {
    startApp();
  }
});

window.playerAPI.onStateChange((state) => {
  $('#status').html(state);
});

window.playerAPI.onUpdateLoop((layouts) => {
  console.debug('[window.playerAPI.onUpdateLoop]', { layouts });
  if (xlr) {
    console.debug('[window.playerAPI.onUpdateLoop] > Emitting updateLoop to XLR');
    xlr.emitter.emit('updateLoop', layouts);
  }
});

window.playerAPI.onUpdateUniqueLayouts(async layouts => {
  if (xlr) {
    console.debug('[Renderer::onUpdateUniqueLayouts]', { layouts });
    await xlr.updateScheduleLayouts(layouts);
  }
});

window.playerAPI.onShowStatusWindow((timeout) => {
  showStatusWindowFn(timeout);
});

const showStatusWindowFn = (timeout: number) => {
  console.debug('[Renderer::onShowStatusWindow]', { timeout });
  $('#status').show();
  setTimeout(() => {
    console.debug('[Renderer::onShowStatusWindow] Hiding status window after timeout of:', timeout + ' seconds');
    $('#status').hide();
  }, timeout * 1000);

};

const init = async () => {
  const config = await window.apiHandler.loadConfig();
  console.debug('[RENDERER] init > config', config);
  window.config = config;

  const showStatusWindow = (event: KeyboardEvent) => {
    if (event.key.toLowerCase() === 'i') {
      // Ignore if the user is typing inside an input field
      const target = event.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }

      console.debug('[Renderer] showStatusWindow event triggered by keypress "i"');
      showStatusWindowFn(60); // Show for 60 seconds
    }
  };

  document.removeEventListener('keydown', showStatusWindow); // Ensure we don't add multiple listeners
  document.addEventListener('keydown', showStatusWindow);

  if (!config.isConfigured) {
    runConfigHandler(config);
  } else {
    const { callbackName } = await window.playerAPI.requestCallback();
    const mainCallback = async (...args) => {
      return await window.playerAPI.invokeCallback(callbackName, ...args);
    };

    // Run mainCallback
    await mainCallback({ context: 'renderer' });

    console.debug('[RENDERER] > startApp(): Called mainCallback');
    await startApp();
  }
};

init();
