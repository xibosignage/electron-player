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
import { dirname, join } from 'path';
import { readFile, writeFile, access } from 'fs/promises';
import { constants } from 'fs';
import xml2js from 'xml2js';

import { Config } from '../config/config';

/** Files written by the legacy player, relative to its config directory. */
const CMS_SETTINGS_FILE = 'cmsSettings.xml';
const PLAYER_SETTINGS_FILE = 'playerSettings.xml';

/** Written into userData once migration has been attempted. Also the idempotency guard. */
export const MIGRATION_MARKER_FILE = 'legacy-migration.json';

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

export type LegacyMigrationResult = {
  migrated: boolean;
  /** Why migration did not happen, when `migrated` is false. */
  reason?: string;
  /** Legacy config directory the settings were read from. */
  sourceDir?: string;
  /** The preserved hardware key (legacy `displayId`). */
  hardwareKey?: string;
  cmsUrl?: string;
  displayName?: string;
  /** Legacy media library path, recorded so operators can reclaim the disk later. */
  legacyLibrary?: string;
  proxyMigrated?: boolean;
  migratedAt?: string;
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

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

/**
 * Pull the settings fields out of a parsed legacy settings document.
 *
 * `parseXmlSafely` already strips the document's single root — the native `<settings
 * version="2">` for current files, or the synthetic wrapper it applies to rootless version 1
 * files (whose loader accepts whatever root it finds: `XmlFileLoaderMissingRoot`, used by
 * `SettingsSerializer::backwardCompatibleLoader`) — so `parsed` here is already the flat
 * settings fields, plus a `$` for any XML attributes (e.g. `version`), which `readField`
 * ignores since it isn't a field name we look up.
 */
function unwrapSettings(parsed: any): Record<string, unknown> {
  if (!parsed || typeof parsed !== 'object') return {};

  // Defensive: only relevant if a document nests its fields under an explicit inner
  // <settings> element that survived the top-level unwrap.
  if (parsed.settings && typeof parsed.settings === 'object') {
    return parsed.settings as Record<string, unknown>;
  }

  return parsed as Record<string, unknown>;
}

/** Read a scalar field, tolerating xml2js quirks and empty elements. */
function readField(settings: Record<string, unknown>, name: string): string | undefined {
  const raw = settings[name];
  if (raw === undefined || raw === null) return undefined;

  // An empty element parses to {} rather than ''.
  if (typeof raw === 'object') return undefined;

  const value = String(raw).trim();
  return value === '' ? undefined : value;
}

/**
 * Safely parses any XML string, providing a fallback root element if the content
 * contains multi-root fragments. Returns a deeply typed config object directly.
 * 
 * @template T - The expected flat structure of the internal configurations.
 * @param xmlString - The raw XML string input.
 * @param options - Configuration overrides for xml2js.
 */
export async function parseXmlSafely<T = Record<string, any>>(
  xmlString: string,
  options: xml2js.Options = { explicitArray: false, trim: true }
): Promise<T> {
  const parser = new xml2js.Parser(options);
  const fallbackWrapper = 'settings';

  // 1. Check if the string needs a preventative fallback wrap right away.
  // Real XML must contain only ONE high-level root node after the declaration header: a
  // single root wraps the *entire* body, so nothing but whitespace remains once its closing
  // tag is found. `rootTagsFound.length > 1` alone can't tell multi-root fragments apart from
  // a single root with nested children (both match more than one opening tag), so walk
  // forward from the first element's matching close tag instead of guessing from `startsWith`
  // (which is always true here, since `firstRootTag` is itself found inside `cleanBody`).
  const cleanBody = xmlString.replace(/^<\?xml.*?\?>/i, '').trim();
  const rootTagsFound = cleanBody.match(/<[a-zA-Z0-9_\-:]+(?:\s[^>]*)?>/g) || [];
  const firstRootTag = rootTagsFound[0] ?? '';
  const firstRootTagName = firstRootTag.match(/^<([a-zA-Z0-9_\-:]+)/)?.[1];

  let isMultiRoot = rootTagsFound.length > 1;
  if (isMultiRoot && firstRootTagName) {
    const closingTag = `</${firstRootTagName}>`;
    const closingIndex = cleanBody.indexOf(closingTag);
    if (closingIndex !== -1) {
      isMultiRoot = cleanBody.slice(closingIndex + closingTag.length).trim() !== '';
    }
  }

  console._log('[LegacyMigration] Initial XML parsing check', {
    xmlString,
    cleanBody,
    rootTagsFound,
    firstRootTag,
    isMultiRoot,
  });

  // If we suspect a multi-root fragment structure, apply wrapper immediately
  let xmlToParse = xmlString;
  let wasWrappedStreamline = false;

  if (isMultiRoot) {
    const declarationMatch = xmlString.match(/^<\?xml.*?\?>/i);
    const declaration = declarationMatch ? declarationMatch[0] : '';
    xmlToParse = `${declaration}\n<${fallbackWrapper}>\n${cleanBody}\n</${fallbackWrapper}>`;
    wasWrappedStreamline = true;
  }

  console._log('[LegacyMigration] Parsing XML with fallback wrapper', {
    wasWrappedStreamline,
    fallbackWrapper,
    xmlToParse,
    rootTagsFound,
    firstRootTag,
  });

  try {
    const parsedResult = await parser.parseStringPromise(xmlToParse) as Record<string, any>;
    
    // 2. Unpack the object safely to give the user consistent type delivery
    if (parsedResult && typeof parsedResult === 'object') {
      const keys = Object.keys(parsedResult);
      
      // If we applied our custom fallback root wrapper, strip it out directly
      if (wasWrappedStreamline && keys.includes(fallbackWrapper)) {
        return parsedResult[fallbackWrapper] as T;
      }
      
      // If the incoming XML already had a single native root (e.g. <config> or <root>)
      if (keys.length === 1) {
        const structuralRoot = keys[0];
        return parsedResult[structuralRoot] as T;
      }
    }

    return parsedResult as unknown as T;

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Fallback handler if the initial regex match missed a specialized multi-root stream configuration
    if (errorMessage.includes('Extra content at the end') && !wasWrappedStreamline) {
      const declarationMatch = xmlString.match(/^<\?xml.*?\?>/i);
      const declaration = declarationMatch ? declarationMatch[0] : '';
      const wrappedXml = `${declaration}\n<${fallbackWrapper}>\n${cleanBody}\n</${fallbackWrapper}>`;

      try {
        const fallbackResult = await parser.parseStringPromise(wrappedXml) as Record<string, any>;
        return fallbackResult[fallbackWrapper] as T;
      } catch (innerError: unknown) {
        const innerMessage = innerError instanceof Error ? innerError.message : String(innerError);
        throw new Error(`XML parsing failed on complex malformation: ${innerMessage}`);
      }
    }

    throw error;
  }
}

async function parseSettingsFile(path: string): Promise<Record<string, unknown>> {
  const xml = await readFile(path, 'utf-8');
  const rootDoc = await parseXmlSafely(xml);

  console._log('[LegacyMigration] Parse Settings File > rootDoc', { rootDoc });

  const unwrappedSettings = unwrapSettings(rootDoc);

  console._log('[LegacyMigration] Unwrapped settings', { unwrappedSettings });
  return unwrappedSettings;
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

function markerPath(config: Config): string {
  return join(dirname(config.savePath), MIGRATION_MARKER_FILE);
}

async function writeMarker(config: Config, result: LegacyMigrationResult): Promise<void> {
  try {
    await writeFile(markerPath(config), JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`[LegacyMigration] Failed to write ${MIGRATION_MARKER_FILE}:`, err);
  }
}

/** True once migration has been attempted, whatever the outcome. */
async function alreadyAttempted(config: Config): Promise<boolean> {
  return exists(markerPath(config));
}

/**
 * Import identity from a legacy 1.8 install, if there is one to import.
 *
 * MUST be called before `Config.load()`. When config.json is absent, `load()` generates a
 * fresh hardware key from machineId and immediately persists it — running after that point
 * would permanently lose the legacy identity.
 *
 * Never throws: a migration failure logs and lets the normal first-run flow proceed.
 */
export async function migrateLegacyPlayer(config: Config): Promise<LegacyMigrationResult> {
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
