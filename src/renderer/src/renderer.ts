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
import XiboLayoutRenderer, { ConsumerPlatform, ELayoutState, InputLayoutType, IXlr, OptionsType } from '@xibosignage/xibo-layout-renderer';
import DefaultLayout from './layout/defaultLayout';

import { ConfigHandler } from './ConfigHandler';
import { ConfigData, SspAdData } from '@shared/types';
import logo from './assets/images/logo.png';
import { DataConnectorManager } from './dataConnector/dataConnectorManager';

// Base URL the local file server serves cached files from. Shared by XLR (for
// layouts/resources) and the data connector manager (for connector scripts) so
// the two can never drift apart.
const APP_HOST = 'http://localhost:9696/files/';

let xlr: IXlr;
let currentSspAd: SspAdData | null = null;

// Hosts data connectors in sandboxed iframes and bridges their realtime data to
// the main process. Driven by the `update-data-connectors` push from main.
const dataConnectorManager = new DataConnectorManager(APP_HOST);

// [DIAG] Temporary renderer event-loop drift detector. Remove after diagnosis.
// If the renderer thread is what freezes, drift will spike to ~the freeze
// duration; if it stays small while main's [EL-LAG] is high, the stall is in
// main. Uses console._log (raw — no IPC) so the probe adds no load.
{
  let __last = Date.now();
  let __maxDrift = 0;
  setInterval(() => {
    const __now = Date.now();
    const __drift = __now - __last - 1000;
    if (__drift > __maxDrift) __maxDrift = __drift;
    __last = __now;
  }, 1000);
  setInterval(() => {
    (console as any)._log(`[DIAG renderer] max event-loop drift in 10s = ${__maxDrift} ms`);
    __maxDrift = 0;
  }, 10_000);

  // [DIAG] Log any renderer long task >150ms with its frame attribution, so we
  // can see WHICH frame blocks: an iframe (connector host xibo-dc-* or a widget
  // M-*) vs the main document (XLR / our manager). containerName/src may be
  // empty for opaque-origin (sandboxed) frames, but containerType still tells
  // us iframe-vs-window.
  try {
    const __lt = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < 150) continue;
        const attr = (entry as any).attribution?.[0];
        (console as any)._log(
          `[DIAG longtask] ${entry.duration.toFixed(0)}ms`
          + (attr
            ? ` container=${attr.containerType} name=${attr.containerName || ''} id=${attr.containerId || ''} src=${attr.containerSrc || ''}`
            : ' (no attribution)'),
        );
      }
    });
    __lt.observe({ entryTypes: ['longtask'] });
  } catch {
    // longtask entry type not supported — ignore.
  }
}

function generateSspXlf(ad: SspAdData): string {
  return '<?xml version="1.0"?>\n' +
    '<layout schemaVersion="1" width="' + ad.width + '" height="' + ad.height + '" bgcolor="#000000" background="">\n' +
    '\t<region id="axe" width="' + ad.width + '" height="' + ad.height + '" top="0" left="0">\n' +
    '\t\t<media id="axe" type="' + ad.xiboType + '" duration="' + ad.duration + '" lkid="1" schemaVersion="1">\n' +
    '\t\t\t<options>\n' +
    '\t\t\t\t<uri>' + ad.url + '</uri>\n' +
    '\t\t\t</options>\n' +
    '\t\t\t<raw/>\n' +
    '\t\t</media>\n' +
    '\t\t<options/>\n' +
    '\t</region>\n' +
    '</layout>\n';
}

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

const faultsBC = new BroadcastChannel('player-faults-bc');

faultsBC.addEventListener('message', (event) => {
  const faultData = event.data;
  console.debug('[Renderer::BroadcastChannel:player-faults-bc] Received fault data', faultData);
  window.playerAPI.reportFault(faultData);
});

/**
 * Callback into the main process, resolved once and shared by everything that needs to
 * re-enter main's startup path — first-boot registration and the config page reopened
 * from the nav bar both use it.
 */
let mainCallback: ((...args: any[]) => Promise<any>) | null = null;

const resolveMainCallback = async () => {
  if (mainCallback !== null) {
    return mainCallback;
  }

  const { callbackName } = await window.playerAPI.requestCallback();
  mainCallback = async (...args) => {
    return await window.playerAPI.invokeCallback(callbackName, ...args);
  };

  return mainCallback;
};

const runConfigHandler = async (config: ConfigData) => {
  const callback = await resolveMainCallback();

  // Show the configure view
  console.log('onConfigure: show configure view');
  const configHandler = new ConfigHandler(config, callback);

  configHandler.init();

  // Run config
  await configHandler.run();
};

/**
 * Resolve a layout code against the locally cached files and play that layout
 * once as an interrupt, resuming the normal loop afterwards.
 *
 * @param layoutCode The CMS layout code identifying the layout to navigate to
 */
const navigateToLayoutByCode = async function (layoutCode: string) {
  const result = await window.apiHandler.findLayoutByCode(layoutCode);
  console.debug('[navLayout] [RENDERER] navigateToLayoutByCode triggered', {
    layoutCode,
    foundLayoutId: result?.layoutId ?? null,
  });

  if (!result) {
    console.warn('[navLayout] [RENDERER] Layout not found for code:', layoutCode);
    return;
  }

  await xlr.playInterruptLayout({
    layoutId: result.layoutId,
    path: result.name,
    response: null,
  });
};

const initXlrEventHandlers = function () {
  xlr.on('sspWidgetRequest', async (media) => {
    console.debug('[XLR::on("sspWidgetRequest")] > Requesting SSP widget ad', {
      mediaId: media.id,
      partnerId: media.options.partnerid,
    });
    const adData = await window.apiHandler.sspGetWidgetAd(media.options.partnerid);
    if (adData) {
      media.setSspAdUrl(
        adData.url,
        adData.xiboType as 'image' | 'video',
        adData.impressionUrls,
        adData.errorUrls,
      );
    }
    // If null → no ad available; XLR will auto-skip via sspWidgetEnd([], [], 0)
  });

  xlr.on('sspWidgetEnd', async (impressionUrls, _errorUrls, duration) => {
    if (impressionUrls.length === 0) return;
    console.debug('[XLR::on("sspWidgetEnd")] > SSP widget played, reporting impression', {
      impressionUrls,
      duration,
    });
    await window.apiHandler.sspReportWidgetImpression(impressionUrls, duration);
  });

  xlr.on('adRequest', async (sspLayoutIndex: number) => {
    console.debug('[XLR::on("adRequest")] > Requesting SSP ad for slot', sspLayoutIndex);
    const adData = await window.apiHandler.sspGetAd();
    if (!adData) {
      console.warn('[RENDERER] [XLR::on("adRequest")] > No SSP ad available');
    }
    currentSspAd = adData;
    xlr.updateInputLayout(sspLayoutIndex, {
      ad: adData ?? null,
      duration: adData?.duration ?? 0,
      layoutId: -1,
      getXlf: () => adData ? generateSspXlf(adData) : '',
    } as InputLayoutType);
  });

  /**
   * Handles an incoming command identified by a CMS-provided command code.
   */
  xlr.on('commandCodeReceived', async (commandCode) => {
    console.log('[RENDERER] > [Xlr::commandCodeReceived] - Received a new command', commandCode);
    await window.apiHandler.executeXlrEvent('commandCodeReceived', { commandCode });
  });

  /**
   * Handles an incoming command provided as an encoded command string.
   */
  xlr.on('commandStringReceived', async (commandString) => {
    console.log('[RENDERER] > [Xlr::commandStringReceived] - Received a new command', commandString);
    await window.apiHandler.executeXlrEvent('commandStringReceived', { commandString });
  });


  xlr.on('layoutStart', async (layout) => {
    // When a layout starts playing, update CMS with the current layout
    // if "Notify current layout" is enabled.
    console.debug('[RENDERER] [XLR::on("layoutStart")] > Layout started', {
      layoutId: layout.layoutId,
    });

    // await window.apiHandler.sendCurrentLayoutAsStatusUpdate(layout.layoutId);
    await window.apiHandler.executeXlrEvent('layoutStart', { layoutId: layout.layoutId });
  });

  xlr.on('navLayout', async (layoutCode: string) => {
    await navigateToLayoutByCode(layoutCode);
  });

  xlr.on('layoutEnd', async (layout) => {
    // SSP impression reporting
    if (layout.layoutId === -1 && currentSspAd) {
      if (layout.state === ELayoutState.PLAYED && currentSspAd.impressionUrls.length > 0) {
        console.debug('[RENDERER] [XLR::on("layoutEnd")] > SSP ad played, reporting impression');
        await window.apiHandler.sspReportImpression(
          currentSspAd.impressionUrls,
          currentSspAd.duration,
          window.config?.state?.latitude ?? null,
          window.config?.state?.longitude ?? null,
        );
      }

      if (layout.state === ELayoutState.ERROR && currentSspAd.errorUrls.length > 0) {
        console.debug('[RENDERER] [XLR::on("layoutEnd")] > SSP ad error, reporting error');
        await window.apiHandler.sspReportError(
          currentSspAd.errorUrls,
          layout.errorCode ?? 405,
        );
      }
      currentSspAd = null;
    }

    if (layout.state !== ELayoutState.PLAYED) return;
    console.debug('[RENDERER] [XLR::on("layoutEnd")] > Layout ended', {
      scheduleId: layout.scheduleId,
    });
    await window.apiHandler.executeXlrEvent('layoutEnd', { scheduleId: layout.scheduleId });
  });

  xlr.on('overlayEnd', async (overlay) => {
    if (overlay.state !== ELayoutState.PLAYED) return;
    console.debug('[RENDERER] [XLR::on("overlayEnd")] > Overlay ended', {
      scheduleId: overlay.scheduleId,
    });
    await window.apiHandler.executeXlrEvent('overlayEnd', { scheduleId: overlay.scheduleId });
  });

}

export const startApp = async () => {
  const config = await window.apiHandler.getConfig();

  const xlrOptions: Partial<OptionsType> = {
    appHost: APP_HOST,
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
    displayTags: config.displayTags ?? {},
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
    // Reached after first-boot registration completes, so this is the point the nav bar
    // becomes useful. Safe to call again if the player booted configured.
    initNavBar();
    startApp();
  }
});

window.playerAPI.onStateChange((state) => {
  if ($('#status').is(':visible')) {
    // Replacing the content empties the scroll container, which clamps scrollTop back to 0.
    // Save and restore it so a refresh doesn't yank the reader away from a long log line.
    const content = document.getElementById('status-content');
    const scrollTop = content?.scrollTop ?? 0;

    $('#status-content').html(state);

    if (content) {
      content.scrollTop = scrollTop;
    }
  }
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

window.playerAPI.onUpdateOverlays(async overlays => {
  if (xlr) {
    console.debug('[Renderer::onUpdateOverlays]', { overlays });
    xlr.emitter.emit('updateOverlays', overlays);
  }
});

window.playerAPI.onShowStatusWindow((timeout) => {
  showStatusWindowFn(timeout);
});

window.playerAPI.onTriggerWebhook(({ triggerCode, widgetId }) => {
  console.debug('[Renderer::onTriggerWebhook] Dispatching webhook trigger to XLR', { triggerCode, widgetId });
  xlr.triggerAction(triggerCode, widgetId);
});

window.playerAPI.onNavigateToLayoutCode(async (layoutCode) => {
  console.debug('[Renderer::onNavigateToLayoutCode] Navigating to layout by code', { layoutCode });
  await navigateToLayoutByCode(layoutCode);
});

window.playerAPI.onXlrExpireWidget((widgetId) => {
  console.debug('[Renderer::onXlrExpireWidget] Expiring widget', { widgetId });
  xlr.expireWidget(widgetId);
});

window.playerAPI.onXlrExtendWidgetDuration((widgetId, duration) => {
  console.debug('[Renderer::onXlrExtendWidgetDuration] Extending widget duration', { widgetId, duration });
  xlr.extendWidgetDuration(widgetId, duration);
});

window.playerAPI.onXlrSetWidgetDuration((widgetId, duration) => {
  console.debug('[Renderer::onXlrSetWidgetDuration] Setting widget duration', { widgetId, duration });
  xlr.setWidgetDuration(widgetId, duration);
});

window.playerAPI.onUpdateDisplayTags((tags) => {
  if (xlr) {
    xlr.config.displayTags = tags;
  }
});

window.playerAPI.onUpdateDataConnectors((connectors) => {
  console.debug('[Renderer::onUpdateDataConnectors]', { count: connectors.length });
  void dataConnectorManager.sync(connectors);
});

window.playerAPI.onNotifyWidgetDataChanged((widgetId) => {
  console.debug('[Renderer::onNotifyWidgetDataChanged] Notifying widget of data change', { widgetId });
  dataConnectorManager.notifyWidgets(widgetId);
});

let statusWindowHideTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Hides the status window and stops the main process pushing state updates to it.
 * Safe to call when the window is already hidden.
 */
const hideStatusWindowFn = (reason: string) => {
  if (statusWindowHideTimer !== null) {
    clearTimeout(statusWindowHideTimer);
    statusWindowHideTimer = null;
  }

  if (!$('#status').is(':visible')) {
    return;
  }

  console.debug('[Renderer::hideStatusWindow] Hiding status window', { reason });
  $('#status').hide();
  window.playerAPI.notifyStatusWindowVisibility(false);

  // Bring the nav bar back, so closing the status window doesn't leave the screen with
  // no way back into it.
  if (navBarEnabled) {
    showNavBar();
  }
};

const showStatusWindowFn = (timeout: number) => {
  console.debug('[Renderer::onShowStatusWindow]', { timeout });

  // Cancel any in-flight hide timer so a second show doesn't cut off updates early.
  if (statusWindowHideTimer !== null) {
    clearTimeout(statusWindowHideTimer);
    statusWindowHideTimer = null;
  }

  // Get the nav bar out of the way — it is fixed across the top, over the status window.
  hideNavBar();

  window.playerAPI.notifyStatusWindowVisibility(true);
  $('#status').show();

  // Focus the scroll container, not the close button, so the arrow keys scroll straight
  // away without a Tab press. Focus goes on the container because the 5-second refresh
  // replaces every child, so anything focused inside would lose focus on the next tick.
  $('#status-content').trigger('focus');

  statusWindowHideTimer = setTimeout(() => {
    hideStatusWindowFn('timeout of ' + timeout + ' seconds elapsed');
  }, timeout * 1000);
};

/**
 * Keys that close the status window while it is open.
 *
 * Handled at the document level rather than only on the close button because a signage
 * remote has no Tab key, so it can never move focus onto the button. Which key a remote
 * actually emits for "back" varies by receiver, hence more than one.
 */
const STATUS_WINDOW_CLOSE_KEYS = ['escape', 'backspace', 'enter'];

/**
 * Shows the status window on "i" and closes it on any of the close keys above.
 */
const onStatusWindowKeydown = (event: KeyboardEvent) => {
  const key = event.key.toLowerCase();
  const isCloseKey = STATUS_WINDOW_CLOSE_KEYS.includes(key);

  if (key !== 'i' && !isCloseKey) {
    return;
  }

  // Ignore if the user is typing inside an input field
  const target = event.target as HTMLElement;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
    return;
  }

  if (isCloseKey) {
    // Only consume the key while the window is open, so Enter and Backspace keep their
    // normal meaning for the config UI and for interactive layouts.
    if (!$('#status').is(':visible')) {
      return;
    }

    event.preventDefault();
    hideStatusWindowFn(key + ' key pressed');
    return;
  }

  // The config page owns the screen while it is open, and it has text inputs of its own.
  if ($('#config').is(':visible')) {
    return;
  }

  console.debug('[Renderer] showStatusWindow event triggered by keypress "i"');
  showStatusWindowFn(60); // Show for 60 seconds
};

/** How long the nav bar stays on screen after the last cursor movement, in seconds. */
const NAV_BAR_IDLE_TIMEOUT = 5;

/** Don't re-arm the hide timer more often than this while the cursor is moving. */
const NAV_BAR_MOUSE_THROTTLE_MS = 250;

let navBarHideTimer: ReturnType<typeof setTimeout> | null = null;
let navBarLastReveal = 0;

/** False until initNavBar() runs, which it only does on a configured player. */
let navBarEnabled = false;

/** The config page reopened from the nav bar, kept so repeat opens reuse one instance. */
let navBarConfigHandler: ConfigHandler | null = null;

const hideNavBar = () => {
  if (navBarHideTimer !== null) {
    clearTimeout(navBarHideTimer);
    navBarHideTimer = null;
  }

  $('#nav-bar').addClass('nav-bar--hidden');
};

/**
 * Reveals the nav bar and arms a fresh idle timer.
 *
 * Suppressed while the status window or the config page is open: the bar exists only to
 * launch those two screens, and it is fixed across the top where it would sit over them.
 */
const showNavBar = () => {
  if ($('#status').is(':visible') || $('#config').is(':visible')) {
    return;
  }

  if (navBarHideTimer !== null) {
    clearTimeout(navBarHideTimer);
  }

  $('#nav-bar').removeClass('nav-bar--hidden');

  navBarHideTimer = setTimeout(() => {
    hideNavBar();
  }, NAV_BAR_IDLE_TIMEOUT * 1000);
};

/**
 * mousemove fires far more often than the idle timer needs re-arming, and this runs on
 * low-powered signage hardware, so throttle the work.
 */
const onNavBarMouseMove = () => {
  const now = Date.now();

  if (now - navBarLastReveal < NAV_BAR_MOUSE_THROTTLE_MS) {
    return;
  }

  navBarLastReveal = now;
  showNavBar();
};

/**
 * Reopens the CMS configuration page from the nav bar. Playback keeps running behind it.
 */
const openConfigPage = async () => {
  if ($('#config').is(':visible')) {
    return;
  }

  hideNavBar();

  // Read the config fresh rather than reusing window.config, which was loaded at boot
  // and may predate a CMS-pushed change.
  const config = await window.apiHandler.getConfig();
  const callback = await resolveMainCallback();

  if (navBarConfigHandler === null) {
    navBarConfigHandler = new ConfigHandler(config, callback);
  } else {
    navBarConfigHandler.config = config;
  }

  await navBarConfigHandler.open({
    onClose: () => {
      showNavBar();
    },
  });
};

/**
 * Wires the on-screen nav bar and reveals it once for the startup showing.
 *
 * Only called on a configured player: during first-boot registration the config page
 * already owns the screen and there is nothing for the bar to launch.
 */
const initNavBar = () => {
  navBarEnabled = true;

  document.removeEventListener('mousemove', onNavBarMouseMove);
  document.addEventListener('mousemove', onNavBarMouseMove);

  $('#nav-status').off('click').on('click', () => {
    console.debug('[Renderer] showStatusWindow triggered from the nav bar');
    showStatusWindowFn(60); // Show for 60 seconds
  });

  $('#nav-config').off('click').on('click', () => {
    console.debug('[Renderer] config page triggered from the nav bar');
    openConfigPage();
  });

  showNavBar();
};

const init = async () => {
  const config = await window.apiHandler.loadConfig();
  console.debug('[RENDERER] init > config', config);
  window.config = config;

  document.removeEventListener('keydown', onStatusWindowKeydown); // Ensure we don't add multiple listeners
  document.addEventListener('keydown', onStatusWindowKeydown);

  $('#status-close').off('click').on('click', () => {
    hideStatusWindowFn('close button clicked');
  });

  if (!config.isConfigured) {
    runConfigHandler(config);
  } else {
    initNavBar();

    const callback = await resolveMainCallback();

    // Run mainCallback
    await callback({ context: 'renderer' });

    console.debug('[RENDERER] > startApp(): Called mainCallback');
    await startApp();
  }
};

init();
