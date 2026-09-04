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
 * One-shot migration from the legacy Xibo Linux 1.8 player (C++/GTK) to this player.
 *
 * The legacy player is published to the snap store under the same name (`xibo-player`), so
 * an in-place snap refresh swaps it for this one. The critical thing to preserve across that
 * swap is the display's identity: the legacy hardware key lives in `cmsSettings.xml` as
 * `displayId` (an MD5 of cpuid + MAC address) and will never match the key this player
 * derives from `machineId()`. Without this migration, every refreshed device registers as a
 * brand-new display in the CMS and loses its layouts, groups, settings and history.
 *
 * Everything here is READ-ONLY with respect to the legacy directory. Nothing is moved,
 * rewritten or deleted, so `snap revert xibo-player` remains a working rollback.
 */
import { join } from 'path';

import { Config } from '../config/config';
import {
  LegacyMigrationResult,
  alreadyAttempted,
  exists,
  parseSettingsFile,
  readField,
  writeMarker,
} from './legacyPlayer';

/** Files written by the legacy player, relative to its config directory. */
const CMS_SETTINGS_FILE = 'cmsSettings.xml';
const PLAYER_SETTINGS_FILE = 'playerSettings.xml';

export type LegacyCmsSettings = {
  cmsAddress?: string;
  key?: string;
  displayId?: string;
  localLibrary?: string;
  domain?: string;
  username?: string;
  password?: string;
};

export type LegacyPlayerSettings = {
  displayName?: string;
  collectInterval?: string;
  logLevel?: string;
};

/**
 * Candidate legacy config directories, most authoritative first.
 *
 * The legacy watchdog (`player/watchdog/main.cpp::setupNewConfigDir`) moves config from
 * SNAP_USER_DATA to SNAP_USER_COMMON on startup, so R6+ devices keep it in COMMON. Devices
 * that never ran a build with that watchdog still have it in SNAP_USER_DATA, so check both.
 *
 * XIBO_LEGACY_CONFIG_DIR covers deb/tarball installs (where the legacy player keeps its
 * config next to the binary, per `AppConfig::execDirectory()`) and local testing.
 */
export function legacyConfigDirCandidates(): string[] {
  return [
    process.env.XIBO_LEGACY_CONFIG_DIR,
    process.env.SNAP_USER_COMMON,
    process.env.SNAP_USER_DATA,
  ].filter((dir): dir is string => Boolean(dir && dir.trim() !== ''));
}

/** First candidate directory that actually holds a readable cmsSettings.xml. */
export async function findLegacyConfigDir(): Promise<string | undefined> {
  for (const dir of legacyConfigDirCandidates()) {
    if (await exists(join(dir, CMS_SETTINGS_FILE))) {
      return dir;
    }
  }

  return undefined;
}

export async function readLegacyCmsSettings(dir: string): Promise<LegacyCmsSettings> {
  const legacyCmsSettingsPath = join(dir, CMS_SETTINGS_FILE);
  const settings = await parseSettingsFile(legacyCmsSettingsPath);

  console._log('[LegacyMigration] Legacy CMS Settings Path', { legacyCmsSettingsPath });
  console._log('[LegacyMigration] Legacy CMS Settings', { settings });

  return {
    cmsAddress: readField(settings, 'cmsAddress'),
    key: readField(settings, 'key'),
    displayId: readField(settings, 'displayId'),
    localLibrary: readField(settings, 'localLibrary'),
    domain: readField(settings, 'domain'),
    username: readField(settings, 'username'),
    password: readField(settings, 'password'),
  };
}

export async function readLegacyPlayerSettings(dir: string): Promise<LegacyPlayerSettings> {
  const path = join(dir, PLAYER_SETTINGS_FILE);
  if (!(await exists(path))) return {};

  const settings = await parseSettingsFile(path);

  return {
    displayName: readField(settings, 'displayName'),
    collectInterval: readField(settings, 'collectInterval'),
    logLevel: readField(settings, 'logLevel'),
  };
}

/**
 * The legacy player stores the proxy as a bare domain plus optional credentials
 * (`CmsSettingsSerializer::proxyFrom`). Normalise it to an absolute URL so it can be handed
 * to Electron's session proxy resolver.
 */
function normaliseProxyUrl(domain: string): string | undefined {
  const trimmed = domain.trim();
  if (trimmed === '') return undefined;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  try {
    return new URL(withScheme).origin;
  } catch {
    console.warn(`[LegacyMigration] Ignoring unparseable proxy domain: ${domain}`);
    return undefined;
  }
}

/**
 * Import identity from a legacy Linux 1.8 install, if there is one to import.
 *
 * MUST be called before `Config.load()`. When config.json is absent, `load()` generates a
 * fresh hardware key from machineId and immediately persists it — running after that point
 * would permanently lose the legacy identity.
 *
 * Never throws: a migration failure logs and lets the normal first-run flow proceed.
 */
export async function migrateLegacyLinuxPlayer(config: Config): Promise<LegacyMigrationResult> {
  try {
    // Only ever a first-boot path. An existing config.json means this player has already
    // been set up and its identity must not be overwritten.
    if (await exists(config.savePath)) {
      return { migrated: false, reason: 'player-already-configured' };
    }

    if (await alreadyAttempted(config)) {
      return { migrated: false, reason: 'already-attempted' };
    }

    const sourceDir = await findLegacyConfigDir();
    if (!sourceDir) {
      return { migrated: false, reason: 'no-legacy-install-found' };
    }

    console.log(`[LegacyMigration] Found legacy player config in ${sourceDir}`);

    const cms = await readLegacyCmsSettings(sourceDir);
    const player = await readLegacyPlayerSettings(sourceDir);

    console._log('[LegacyMigration] Legacy CMS Settings', { cms });
    console._log('[LegacyMigration] Legacy Player Settings', { player });

    // displayId is the whole point of this migration. If the legacy player never persisted
    // one it was falling back to a value computed at runtime and never written, so there is
    // no identity to preserve — let the normal first-run flow take over.
    if (!cms.displayId || !cms.cmsAddress || !cms.key) {
      const result: LegacyMigrationResult = {
        migrated: false,
        reason: 'legacy-config-incomplete',
        sourceDir,
        migratedAt: new Date().toISOString(),
      };
      console.warn(
        `[LegacyMigration] Legacy config in ${sourceDir} is incomplete ` +
        `(displayId=${Boolean(cms.displayId)}, cmsAddress=${Boolean(cms.cmsAddress)}, key=${Boolean(cms.key)}); skipping.`,
      );
      await writeMarker(config, result);
      return result;
    }

    config.hardwareKey = cms.displayId;
    config.cmsUrl = cms.cmsAddress;
    config.cmsKey = cms.key;

    // Carry the display name so the first RegisterDisplay doesn't announce the placeholder
    // name this player would otherwise use.
    if (player.displayName) {
      config.displayName = player.displayName;
    }

    const proxyUrl = cms.domain ? normaliseProxyUrl(cms.domain) : undefined;
    if (proxyUrl) {
      config.proxy = {
        url: proxyUrl,
        username: cms.username,
        password: cms.password,
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
      hardwareKey: cms.displayId,
      cmsUrl: cms.cmsAddress,
      displayName: player.displayName,
      legacyLibrary: cms.localLibrary,
      proxyMigrated: Boolean(proxyUrl),
      migratedAt: new Date().toISOString(),
    };

    await writeMarker(config, result);

    console.log(
      `[LegacyMigration] Migrated identity from legacy player: ` +
      `hardwareKey=${cms.displayId}, cms=${cms.cmsAddress}, proxy=${Boolean(proxyUrl)}`,
    );

    if (cms.localLibrary) {
      console.log(
        `[LegacyMigration] Legacy media library at ${cms.localLibrary} is NOT reused; ` +
        `files will be re-downloaded from the CMS. It can be deleted to reclaim disk.`,
      );
    }

    return result;
  } catch (err) {
    console.error('[LegacyMigration] Migration failed, continuing with normal startup:', err);
    return { migrated: false, reason: 'error' };
  }
}
