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
 * One-shot migration from a legacy Xibo player to this player.
 *
 * The critical thing to preserve when a device swaps its legacy player for this one is its
 * identity: the legacy hardware key will never match the key this player derives from
 * machineId(). Without this migration, every migrated device registers as a brand-new display
 * in the CMS and loses its layouts, groups, settings and history.
 *
 * Everything here is READ-ONLY with respect to the legacy install. Nothing is moved, rewritten
 * or deleted, so the legacy player is left intact for rollback.
 *
 * This module holds the platform-agnostic pieces (XML parsing tolerant of legacy quirks, the
 * migration-marker idempotency guard) shared by the platform-specific readers in
 * legacyLinuxPlayer.ts and legacyWindowsPlayer.ts, plus the dispatcher that picks between them.
 */
import { dirname, join } from 'path';
import { readFile, writeFile, access } from 'fs/promises';
import { constants } from 'fs';
import xml2js from 'xml2js';

import { Config } from '../config/config';
import { migrateLegacyLinuxPlayer } from './legacyLinuxPlayer';
import { migrateLegacyWindowsPlayer } from './legacyWindowsPlayer';

/** Written into userData once migration has been attempted. Also the idempotency guard. */
export const MIGRATION_MARKER_FILE = 'legacy-migration.json';

export type LegacyMigrationResult = {
  migrated: boolean;
  /** Why migration did not happen, when `migrated` is false. */
  reason?: string;
  /** Legacy config directory the settings were read from. */
  sourceDir?: string;
  /** The preserved hardware key (legacy displayId/hardwarekey). */
  hardwareKey?: string;
  cmsUrl?: string;
  displayName?: string;
  /** Legacy media library path, recorded so operators can reclaim the disk later. */
  legacyLibrary?: string;
  proxyMigrated?: boolean;
  migratedAt?: string;
};

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pull the settings fields out of a parsed legacy settings document.
 *
 * `parseXmlSafely` already strips the document's single root, so `parsed` here is already the
 * flat settings fields, plus a `$` for any XML attributes (e.g. `version`), which `readField`
 * ignores since it isn't a field name we look up.
 */
export function unwrapSettings(parsed: any): Record<string, unknown> {
  if (!parsed || typeof parsed !== 'object') return {};

  // Defensive: only relevant if a document nests its fields under an explicit inner
  // <settings> element that survived the top-level unwrap.
  if (parsed.settings && typeof parsed.settings === 'object') {
    return parsed.settings as Record<string, unknown>;
  }

  return parsed as Record<string, unknown>;
}

/** Read a scalar field, tolerating xml2js quirks and empty elements. */
export function readField(settings: Record<string, unknown>, name: string): string | undefined {
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

export async function parseSettingsFile(path: string): Promise<Record<string, unknown>> {
  const xml = await readFile(path, 'utf-8');
  const rootDoc = await parseXmlSafely(xml);

  console._log('[LegacyMigration] Parse Settings File > rootDoc', { rootDoc });

  const unwrappedSettings = unwrapSettings(rootDoc);

  console._log('[LegacyMigration] Unwrapped settings', { unwrappedSettings });
  return unwrappedSettings;
}

export function markerPath(config: Config): string {
  return join(dirname(config.savePath), MIGRATION_MARKER_FILE);
}

export async function writeMarker(config: Config, result: LegacyMigrationResult): Promise<void> {
  try {
    await writeFile(markerPath(config), JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`[LegacyMigration] Failed to write ${MIGRATION_MARKER_FILE}:`, err);
  }
}

/** True once migration has been attempted, whatever the outcome. */
export async function alreadyAttempted(config: Config): Promise<boolean> {
  return exists(markerPath(config));
}

/**
 * Import identity from a legacy install, if there is one to import. Dispatches to the
 * platform-specific reader for the legacy player this device used to run.
 *
 * MUST be called before `Config.load()`. When config.json is absent, `load()` generates a
 * fresh hardware key from machineId and immediately persists it — running after that point
 * would permanently lose the legacy identity.
 *
 * Never throws: a migration failure logs and lets the normal first-run flow proceed.
 */
export async function migrateLegacyPlayer(config: Config): Promise<LegacyMigrationResult> {
  return config.platform === 'win32'
    ? migrateLegacyWindowsPlayer(config)
    : migrateLegacyLinuxPlayer(config);
}
