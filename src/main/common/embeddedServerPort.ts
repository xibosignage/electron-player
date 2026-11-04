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
 * Port of the embedded web server (local file server + Player API).
 *
 * Resolved once per process, in this order:
 *   1. XIBO_EMBEDDED_SERVER_PORT environment variable (local override, wins over the CMS)
 *   2. `embeddedServerPort` from the CMS display profile / display override,
 *      as saved by the last RegisterDisplay
 *   3. 9696
 *
 * A configurable port lets more than one player run on the same machine (for example
 * one per screen, each as its own snap instance), which a fixed port made impossible.
 */
export const DEFAULT_EMBEDDED_SERVER_PORT = 9696;

export const EMBEDDED_SERVER_PORT_ENV = 'XIBO_EMBEDDED_SERVER_PORT';

let currentPort: number | null = null;

/** Parses a port value from the CMS or environment, or null when it is not a usable port. */
export function parsePort(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  return port;
}

/** True when the port is pinned locally, so the CMS setting is ignored. */
export function isPortPinnedByEnv(): boolean {
  return parsePort(process.env[EMBEDDED_SERVER_PORT_ENV]) !== null;
}

/**
 * Works out which port the server should use, from the environment and the saved settings.
 *
 * @param settings The player's saved CMS settings (Config.settings)
 */
export function resolveEmbeddedServerPort(settings: Record<string, unknown> | null | undefined): number {
  const fromEnv = parsePort(process.env[EMBEDDED_SERVER_PORT_ENV]);
  if (fromEnv !== null) {
    return fromEnv;
  }

  const fromCms = parsePort(settings?.['embeddedServerPort']);
  if (fromCms !== null) {
    return fromCms;
  }

  return DEFAULT_EMBEDDED_SERVER_PORT;
}

/** Fixes the port for this process. Called once, before the server starts. */
export function setEmbeddedServerPort(port: number): void {
  currentPort = port;
}

/** The port this process serves on. */
export function getEmbeddedServerPort(): number {
  return currentPort ?? DEFAULT_EMBEDDED_SERVER_PORT;
}

/** Origin of the embedded web server, e.g. `http://localhost:9696`. */
export function getEmbeddedServerOrigin(port: number = getEmbeddedServerPort()): string {
  return `http://localhost:${port}`;
}

/**
 * True when the URL is served by the embedded web server. Compares the whole origin, so port
 * 969 does not also match http://localhost:9696/... Both sides go through URL, which drops a
 * default port (80), so that case compares equal too.
 */
export function isEmbeddedServerUrl(url: string): boolean {
  try {
    return new URL(url).origin === new URL(getEmbeddedServerOrigin()).origin;
  } catch {
    return false;
  }
}
