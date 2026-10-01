/*
 * Copyright (c) 2026 Xibo Signage Ltd
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
import { BrowserWindow, ipcMain, WebFrameMain } from 'electron';

/**
 * Cursor handling for the CMS "Enable Mouse" display profile setting.
 *
 * The renderer decides when the cursor shows (see updateCursor in renderer.ts) and
 * styles its own document. Main helps with the two things the renderer cannot do itself:
 *
 *  - Widgets play in iframes, and the cursor over an iframe is decided by the iframe's
 *    document, which the renderer cannot style (other origins, some sandboxed). Main can
 *    script every frame, so it injects the cursor-hiding style into each subframe.
 *  - Mouse events over an iframe go to the iframe, never to the renderer's document, so
 *    the renderer cannot see the mouse moving over a widget. Main sees every input event
 *    the window receives and forwards real mouse movement on.
 */

const STYLE_ID = 'xibo-player-hide-cursor';

/** Don't forward mouse movement more often than this. */
const MOUSE_MOVE_THROTTLE_MS = 250;

/** Hidden until the renderer says otherwise, as expected on a signage screen. */
let cursorVisible = false;

const cursorScript = (visible: boolean) => `(() => {
  let style = document.getElementById('${STYLE_ID}');
  if (${visible}) {
    style?.remove();
    return;
  }
  if (style) {
    return;
  }
  style = document.createElement('style');
  style.id = '${STYLE_ID}';
  style.textContent = '*, *::before, *::after { cursor: none !important; }';
  (document.head || document.documentElement).appendChild(style);
})()`;

const applyToFrame = (frame: WebFrameMain) => {
  // The renderer's own document is styled by the renderer.
  if (frame.parent === null || frame.detached) {
    return;
  }

  frame.executeJavaScript(cursorScript(cursorVisible)).catch((error) => {
    console.debug('[Mouse::applyToFrame] > Could not apply the cursor style to a frame', {
      url: frame.url,
      error: String(error),
    });
  });
};

export const configureMouse = (win: BrowserWindow) => {
  // Keep each new widget frame in step with the cursor as it loads.
  win.webContents.on('frame-created', (_event, { frame }) => {
    frame?.on('dom-ready', () => {
      if (!cursorVisible) {
        applyToFrame(frame);
      }
    });
  });

  ipcMain.on('cursor-visibility', (_event, visible: boolean) => {
    if (visible === cursorVisible) {
      return;
    }

    cursorVisible = visible;
    win.webContents.mainFrame.framesInSubtree.forEach(applyToFrame);
  });

  // Only a physical mouse sends mouseMove here. A touch arrives as touch and gesture events,
  // and the mouse events a page sees when content changes under a still cursor (a layout
  // change after an interactive action, say) are made up inside the page, so neither
  // reveals the nav bar. Comparing positions also drops moves that go nowhere.
  let lastX: number | null = null;
  let lastY: number | null = null;
  let lastSent = 0;

  win.webContents.on('input-event', (_event, input) => {
    if (input.type !== 'mouseMove') {
      return;
    }

    // Window coordinates, as globalX/globalY can come through as 0.
    const { x, y } = input as Electron.MouseInputEvent;
    if (x === lastX && y === lastY) {
      return;
    }
    lastX = x;
    lastY = y;

    const now = Date.now();
    if (now - lastSent < MOUSE_MOVE_THROTTLE_MS) {
      return;
    }
    lastSent = now;

    win.webContents.send('mouse-moved');
  });
};

/**
 * Passes the CMS setting on to the renderer, which shows the cursor at all times while it
 * is on.
 */
export const setMouseEnabled = (win: BrowserWindow, enabled: boolean) => {
  win.webContents.send('update-mouse-enabled', enabled);
};
