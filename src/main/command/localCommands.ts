import axios from "axios";
import { Xmds } from "../xmds/xmds";
import { commandManager } from "../../shared/command/commandManager";
import { BrowserWindow } from "electron";

export async function registerLocalCommands({
  xmds,
  win,
}: {
  xmds: Xmds;
  statusWindow?: HTMLElement | null;
  win: BrowserWindow;
}) {
  /**
   * Executes an HTTP request based on parameters provided in the command string
   * and returns the response as a string for validation.
   */
  commandManager.registerCommand('http', async (url, contentType, requestConfigJson) => {
    let requestConfig;

    // Parse request config
    try {
      requestConfig = JSON.parse(requestConfigJson);
    } catch {
      throw new Error('[CommandManager] Invalid HTTP command request config JSON');
    }

    let headers: Record<string, string> = {};
    if (requestConfig.headers) {
      try {
        // Parse optional headers
        headers = JSON.parse(requestConfig.headers);
      } catch {
        throw new Error('[CommandManager] Invalid HTTP command headers JSON');
      }
    }

    // Apply content type if provided
    if (contentType) {
      headers['Content-Type'] = contentType;
    }

    // Execute HTTP request
    const response = await axios({
      method: requestConfig.method || 'GET',
      url,
      headers,
      data: requestConfig.body || undefined
    });

    // Get the URL without query params for logging
    const requestUrl = url.split('?')[0];

    console.debug('[CommandManager] HTTP command completed', {
      url: requestUrl
    });

    // Always return a string for validation
    if (typeof response.data === 'string') {
      return response.data;
    }

    return JSON.stringify(response.data);
  });

  /**
   * Refreshes the PWA page
   */
  commandManager.registerCommand('refresh', async () => {
    console.alert(`Command refresh executed successfully`, {
      shouldParse: false,
      eventType: 'Command',
      alertType: 'both',
    });
    window.location.reload();
  });

  /**
   * Displays the status window for a specified number of seconds,
   * then automatically hides it.
   */
  commandManager.registerCommand('showStatusWindow', async (timeout) => {
    const seconds = Number(timeout) || 60;

    if (win.isVisible()) {
      console.log('[CommandManager::showStatusWindow] - Showing status window');
      win.webContents.send('showStatusWindow', seconds);
    }
  });

  /**
   * Triggered when the CMS asks for the device's current geolocation.
   * The geolocation manager already keeps the latest coordinates updated,
   * so we simply notify the CMS with the current status.
   */
  commandManager.registerCommand('currentGeoLocation', async () => {
    console.log('[CommandManager::currentGeoLocation] - Sending current geolocation status');
    await xmds.notifyStatus(['latitude', 'longitude']);
  });

  /**
   * Triggers the notifyStatus() to report the player's current state back to the CMS.
   */
  commandManager.registerCommand('status', async () => {
    console.log('[CommandManager::sendStatus] - Sending current status to CMS');
    await xmds.notifyStatus();
  });
}
