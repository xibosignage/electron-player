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
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

/**
 * True when the player is running from a snap package.
 */
export function isSnap(): boolean {
  return Boolean(process.env.SNAP && process.env.SNAP_USER_COMMON);
}

/**
 * Directory for bulk, long-lived player data — the media library, the file store and the
 * stats database.
 *
 * Inside a snap, HOME is remapped to SNAP_USER_DATA, which is *versioned*
 * (~/snap/xibo-player/<revision>/). snapd copies that directory forward on every refresh,
 * so a media library living there would be duplicated on each update. SNAP_USER_COMMON
 * (~/snap/xibo-player/common/) is shared across revisions, so bulk data belongs there.
 *
 * Outside a snap this is just the Electron userData directory, unchanged.
 *
 * Note the legacy 1.8 player also uses SNAP_USER_COMMON directly for its own config, so we
 * keep player data in a subdirectory to avoid mixing with files the migration reads.
 */
export function getPlayerDataDir(userDataPath: string): string {
  const dir = isSnap() ? join(process.env.SNAP_USER_COMMON as string, 'player-data') : userDataPath;

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  return dir;
}
