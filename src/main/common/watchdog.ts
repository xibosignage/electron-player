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

/**
 * Replacement for the legacy 1.8 player's external watchdog process
 * (`xibo-linux/player/watchdog/ProcessWatcher.cpp`), which restarted the player binary
 * whenever it exited. Devices refreshing from that snap would otherwise lose
 * restart-on-crash, so this restores equivalent behaviour in-process.
 */
import { app, BrowserWindow } from 'electron';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';

import { getPlayerDataDir, isSnap } from './paths';

/** Give up relaunching if we exceed this many restarts inside the window below. */
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 10 * 60 * 1000;

const RESTART_LOG_FILE = 'watchdog-restarts.json';

const AUTOSTART_ENTRY = `[Desktop Entry]
Type=Application
Name=Xibo Player
Comment=Xibo for Linux Digital Signage Player
Exec=xibo-player
Terminal=false
X-GNOME-Autostart-enabled=true
`;

function restartLogPath(): string {
  return join(getPlayerDataDir(app.getPath('userData')), RESTART_LOG_FILE);
}

/** Recent restart timestamps, pruned to the rolling window. */
function readRecentRestarts(): number[] {
  try {
    const raw = readFileSync(restartLogPath(), 'utf-8');
    const cutoff = Date.now() - RESTART_WINDOW_MS;
    return (JSON.parse(raw) as number[]).filter((ts) => ts > cutoff);
  } catch {
    return [];
  }
}

function recordRestart(timestamps: number[]): void {
  try {
    writeFileSync(restartLogPath(), JSON.stringify([...timestamps, Date.now()]));
  } catch (err) {
    console.error('[Watchdog] Failed to record restart:', err);
  }
}

/**
 * Restart the whole player process, mirroring what the legacy watchdog did.
 *
 * A renderer crash leaves the main process holding stale playback state, so a clean
 * relaunch is more predictable than reloading the renderer in place (and avoids
 * re-registering the IPC handlers that `init()` sets up once per process).
 */
function relaunchPlayer(reason: string): void {
  const recent = readRecentRestarts();

  if (recent.length >= MAX_RESTARTS) {
    console.error(
      `[Watchdog] ${reason}, but ${recent.length} restarts already occurred in the last ` +
      `${RESTART_WINDOW_MS / 60000} minutes. Not restarting again — the player is left running ` +
      `so the fault can be diagnosed.`,
    );
    return;
  }

  console.error(`[Watchdog] ${reason}. Restarting player (restart ${recent.length + 1}/${MAX_RESTARTS}).`);

  recordRestart(recent);
  app.relaunch();
  app.exit(0);
}

let childProcessHandlerAttached = false;

/**
 * Watch the given window for renderer failures and restart the player when one occurs.
 *
 * Safe to call for each window created — the app-level listener is only attached once.
 */
export function installCrashRecovery(win: BrowserWindow): void {
  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    relaunchPlayer(`Renderer process gone (reason: ${details.reason}, exitCode: ${details.exitCode})`);
  });

  win.on('unresponsive', () => {
    relaunchPlayer('Renderer became unresponsive');
  });

  if (childProcessHandlerAttached) return;
  childProcessHandlerAttached = true;

  app.on('child-process-gone', (_event, details) => {
    // GPU/utility processes are restarted by Chromium on its own; only a lost renderer
    // actually stops playback.
    if (details.type !== 'GPU' || details.reason === 'clean-exit') return;
    console.warn(`[Watchdog] GPU process gone (reason: ${details.reason}); Chromium will recover it.`);
  });
}

/**
 * Start the player automatically when the desktop session logs in, replacing the autostart
 * the legacy snap got from its `xibo-player.desktop` entry.
 *
 * Under snap confinement the real ~/.config is not writable, so the entry goes in
 * SNAP_USER_DATA, which snapd's user session agent scans for autostart entries.
 */
function ensureLinuxAutostartEntry(): void {
  try {
    const base = isSnap() ? (process.env.SNAP_USER_DATA as string) : homedir();
    const autostartDir = join(base, '.config', 'autostart');
    const entryPath = join(autostartDir, 'xibo-player.desktop');

    if (existsSync(entryPath)) return;

    mkdirSync(autostartDir, { recursive: true });
    writeFileSync(entryPath, AUTOSTART_ENTRY);

    console.log(`[Watchdog] Wrote autostart entry to ${entryPath}`);
  } catch (err) {
    console.error('[Watchdog] Failed to write autostart entry:', err);
  }
}

/**
 * Start the player automatically when the user logs in, replacing whatever autostart mechanism
 * (Startup shortcut, Run key, or a legacy watchdog service) the legacy Windows player used.
 *
 * `setLoginItemSettings` is Electron's cross-platform wrapper for the `HKCU\...\Run` registry
 * key on Windows — no manual registry or shortcut handling needed.
 */
function ensureWindowsAutostartEntry(): void {
  try {
    app.setLoginItemSettings({ openAtLogin: true });
    console.log('[Watchdog] Configured login item for autostart');
  } catch (err) {
    console.error('[Watchdog] Failed to configure autostart:', err);
  }
}

/**
 * Start the player automatically when the desktop session logs in. Dispatches to the
 * platform-appropriate mechanism — Windows and Linux have no autostart primitive in common.
 */
export function ensureAutostartEntry(): void {
  if (process.platform === 'win32') {
    ensureWindowsAutostartEntry();
    return;
  }

  ensureLinuxAutostartEntry();
}
