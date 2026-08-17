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
 * One-shot migration from the legacy Xibo Windows player (`xibosignage/xibo-dotnetclient`,
 * WPF/.NET) to this player. The on-disk config format is unchanged across that codebase's
 * releases (verified against both its `master` and `release/tempel` (v1.8) branches), so this
 * reader is not tied to a specific legacy version.
 *
 * The legacy player is a per-user app that stores its identity across three files:
 *  - `%APPDATA%\<exe-basename>.xml` (`ApplicationSettings.Save()`) — CMS address/key, library
 *    path and proxy. The basename tracks the running module, so it's `XiboClient.xml` normally
 *    or `Xibo.xml` when run in screensaver mode as `Xibo.scr`.
 *  - `<LibraryPath>\hardwarekey` — plain text, not XML. MD5(CPUID + volume serial + MAC),
 *    computed once by the legacy player (`HardwareKey.Regenerate()`) and never derivable by us;
 *    this is the identity this migration exists to preserve.
 *  - `<LibraryPath>\config.xml` (`<PlayerSettings>`) — DisplayName and other player settings.
 *
 * Unlike the Linux migration there is no single trigger (e.g. a shared package name) that
 * guarantees this code runs against a freshly-replaced legacy install — see
 * docs/UPGRADING-FROM-WINDOWS.md for the delivery-mechanism caveat. This module only concerns
 * itself with what happens once the new player actually starts on a device that still has the
 * legacy config sitting on disk.
 *
 * Everything here is READ-ONLY with respect to the legacy files.
 */
import { app } from 'electron';
import { dirname, join } from 'path';
import { readFile } from 'fs/promises';
import { hostname } from 'os';

import { Config } from '../config/config';
import {
  LegacyMigrationResult,
  alreadyAttempted,
  exists,
  parseSettingsFile,
  readField,
  writeMarker,
} from './legacyPlayer';

/** Basename of the global settings file, in the order the legacy player would have used it. */
const GLOBAL_SETTINGS_CANDIDATES = ['XiboClient.xml', 'Xibo.xml'];

/** Written by `default.config.xml`; means "never configured", not a real key. */
const PLACEHOLDER_SERVER_KEY = 'yourserverkey';

/** Sentinel `ApplicationSettings.LibraryPath` ships with; resolved at runtime by the legacy app. */
const DEFAULT_LIBRARY_SENTINEL = 'DEFAULT';

/** Sentinel `ApplicationSettings.DisplayName` ships with. */
const COMPUTERNAME_SENTINEL = 'COMPUTERNAME';

type LegacyWindowsGlobalSettings = {
  serverUri?: string;
  serverKey?: string;
  libraryPath?: string;
  proxyUser?: string;
  proxyPassword?: string;
  proxyDomain?: string;
  proxyPort?: string;
};

type LegacyWindowsPlayerSettings = {
  displayName?: string;
};

/**
 * Directory the legacy player's global settings file lives in.
 *
 * `XIBO_LEGACY_WINDOWS_CONFIG_DIR` is for testing against a fixture directory; real devices
 * always use `%APPDATA%`, which Electron's `app.getPath('appData')` matches exactly (.NET's
 * `Environment.SpecialFolder.ApplicationData`).
 */
function legacyAppDataDir(): string {
  return process.env.XIBO_LEGACY_WINDOWS_CONFIG_DIR || app.getPath('appData');
}

/** First candidate global settings file that actually exists. */
async function findLegacyGlobalSettingsPath(): Promise<string | undefined> {
  const dir = legacyAppDataDir();

  for (const name of GLOBAL_SETTINGS_CANDIDATES) {
    const path = join(dir, name);
    if (await exists(path)) {
      return path;
    }
  }

  return undefined;
}

async function readLegacyGlobalSettings(path: string): Promise<LegacyWindowsGlobalSettings> {
  const settings = await parseSettingsFile(path);

  console._log('[LegacyMigration] Legacy Windows global settings path', { path });
  console._log('[LegacyMigration] Legacy Windows global settings', { settings });

  return {
    serverUri: readField(settings, 'ServerUri'),
    serverKey: readField(settings, 'ServerKey'),
    libraryPath: readField(settings, 'LibraryPath'),
    proxyUser: readField(settings, 'ProxyUser'),
    proxyPassword: readField(settings, 'ProxyPassword'),
    proxyDomain: readField(settings, 'ProxyDomain'),
    proxyPort: readField(settings, 'ProxyPort'),
  };
}

/**
 * Resolve the legacy library path exactly as `ApplicationSettings.LibraryPath` does: an unset
 * or literal "DEFAULT" value falls back to `<Documents>\<AssemblyProduct> Library`, which is
 * "Xibo Library" for this player.
 */
function resolveLegacyLibraryPath(libraryPath: string | undefined): string {
  if (!libraryPath || libraryPath === DEFAULT_LIBRARY_SENTINEL) {
    return join(app.getPath('documents'), 'Xibo Library');
  }

  return libraryPath;
}

/** The legacy hardware key, read verbatim — including the legacy fallback literal it may hold
 * if CPU/volume lookup ever failed on that device, since the CMS may already know it by that
 * value. */
async function readLegacyHardwareKey(libraryPath: string): Promise<string | undefined> {
  const path = join(libraryPath, 'hardwarekey');
  if (!(await exists(path))) return undefined;

  const raw = await readFile(path, 'utf-8');
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

async function readLegacyPlayerSettings(libraryPath: string): Promise<LegacyWindowsPlayerSettings> {
  const path = join(libraryPath, 'config.xml');
  if (!(await exists(path))) return {};

  const settings = await parseSettingsFile(path);
  const displayName = readField(settings, 'DisplayName');

  return {
    displayName: displayName === COMPUTERNAME_SENTINEL ? hostname() : displayName,
  };
}

/**
 * The legacy player stores the proxy as separate domain/port/credential fields
 * (`ApplicationSettings.ProxyDomain/ProxyPort/ProxyUser/ProxyPassword`). Join domain+port into
 * an absolute URL so it can be handed to Electron's session proxy resolver.
 */
function normaliseProxyUrl(domain: string, port: string | undefined): string | undefined {
  const trimmed = domain.trim();
  if (trimmed === '') return undefined;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  try {
    const url = new URL(withScheme);
    if (port && port.trim() !== '' && !url.port) {
      url.port = port.trim();
    }
    return url.origin;
  } catch {
    console.warn(`[LegacyMigration] Ignoring unparseable proxy domain: ${domain}`);
    return undefined;
  }
}

/**
 * Import identity from a legacy Windows install, if there is one to import.
 *
 * MUST be called before `Config.load()`. When config.json is absent, `load()` generates a
 * fresh hardware key from machineId and immediately persists it — running after that point
 * would permanently lose the legacy identity.
 *
 * Never throws: a migration failure logs and lets the normal first-run flow proceed.
 */
export async function migrateLegacyWindowsPlayer(config: Config): Promise<LegacyMigrationResult> {
  try {
    // Only ever a first-boot path. An existing config.json means this player has already
    // been set up and its identity must not be overwritten.
    if (await exists(config.savePath)) {
      return { migrated: false, reason: 'player-already-configured' };
    }

    if (await alreadyAttempted(config)) {
      return { migrated: false, reason: 'already-attempted' };
    }

    const globalSettingsPath = await findLegacyGlobalSettingsPath();
    if (!globalSettingsPath) {
      return { migrated: false, reason: 'no-legacy-install-found' };
    }

    const sourceDir = dirname(globalSettingsPath);
    console.log(`[LegacyMigration] Found legacy Windows player config at ${globalSettingsPath}`);

    const global = await readLegacyGlobalSettings(globalSettingsPath);
    const libraryPath = resolveLegacyLibraryPath(global.libraryPath);
    const hardwareKey = await readLegacyHardwareKey(libraryPath);
    const player = await readLegacyPlayerSettings(libraryPath);

    console._log('[LegacyMigration] Legacy Windows player settings', { player });

    // The shipped default.config.xml carries a placeholder ServerKey; a device that never
    // really got configured beyond that default has no identity worth preserving.
    const serverKey = global.serverKey && global.serverKey !== PLACEHOLDER_SERVER_KEY
      ? global.serverKey
      : undefined;

    // hardwareKey is the whole point of this migration — without it there is nothing to
    // preserve, so let the normal first-run flow take over.
    if (!hardwareKey || !global.serverUri || !serverKey) {
      const result: LegacyMigrationResult = {
        migrated: false,
        reason: 'legacy-config-incomplete',
        sourceDir,
        migratedAt: new Date().toISOString(),
      };
      console.warn(
        `[LegacyMigration] Legacy Windows config in ${sourceDir} is incomplete ` +
        `(hardwareKey=${Boolean(hardwareKey)}, serverUri=${Boolean(global.serverUri)}, serverKey=${Boolean(serverKey)}); skipping.`,
      );
      await writeMarker(config, result);
      return result;
    }

    config.hardwareKey = hardwareKey;
    config.cmsUrl = global.serverUri;
    config.cmsKey = serverKey;

    // Carry the display name so the first RegisterDisplay doesn't announce the placeholder
    // name this player would otherwise use.
    if (player.displayName) {
      config.displayName = player.displayName;
    }

    const proxyUrl = global.proxyDomain
      ? normaliseProxyUrl(global.proxyDomain, global.proxyPort)
      : undefined;
    if (proxyUrl) {
      config.proxy = {
        url: proxyUrl,
        username: global.proxyUser,
        password: global.proxyPassword,
      };
    }

    // macAddress/xmrChannel are not carried: the former is re-read from the device, the
    // latter is regenerated and re-registered with the CMS on the next RegisterDisplay.
    config.macAddress = config.getMacAddress();

    await config.save();
    await config.saveCms();

    const result: LegacyMigrationResult = {
      migrated: true,
      sourceDir,
      hardwareKey,
      cmsUrl: global.serverUri,
      displayName: player.displayName,
      legacyLibrary: libraryPath,
      proxyMigrated: Boolean(proxyUrl),
      migratedAt: new Date().toISOString(),
    };

    await writeMarker(config, result);

    console.log(
      `[LegacyMigration] Migrated identity from legacy Windows player: ` +
      `hardwareKey=${hardwareKey}, cms=${global.serverUri}, proxy=${Boolean(proxyUrl)}`,
    );

    console.log(
      `[LegacyMigration] Legacy media library at ${libraryPath} is NOT reused; ` +
      `files will be re-downloaded from the CMS. It can be deleted to reclaim disk.`,
    );

    return result;
  } catch (err) {
    console.error('[LegacyMigration] Windows migration failed, continuing with normal startup:', err);
    return { migrated: false, reason: 'error' };
  }
}
