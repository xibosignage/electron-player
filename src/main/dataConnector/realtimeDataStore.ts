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

export interface RealtimeDataRecord {
  dataKey: string;
  dataSetId: number;
  data: string;
  lastUpdated: number;
}

/**
 * The Electron equivalent of the ChromeOS player's `RealtimeDataLib`.
 *
 * Data connectors run in sandboxed iframes in the renderer and publish their
 * output via `window.xiboDC.setData()`. The renderer forwards each write to the
 * main process over IPC, which stores it here. The in-process Express server
 * (see `express.ts`) reads it back when a widget requests
 * `/realtime?dataKey=...`.
 *
 * Unlike ChromeOS (which persists to IndexedDB so the service worker can serve
 * data), this store is intentionally **in-memory**: real-time data is ephemeral
 * and is repopulated by the connectors on the next assessment after a restart,
 * so there is no benefit to persisting it. Keeping it in main process memory
 * means the Express `/realtime` handler can read it synchronously with no DB or
 * cross-process hop.
 */
export class RealtimeDataStore {
  private records = new Map<string, RealtimeDataRecord>();

  /**
   * Store (or replace) the value for a dataKey. Last write wins.
   */
  set(dataKey: string, dataSetId: number, data: string): void {
    this.records.set(String(dataKey), {
      dataKey,
      dataSetId,
      data,
      lastUpdated: Date.now(),
    });

    console._log('[RealtimeDataStore] Set data', {
      dataKey,
      dataSetId,
      data,
      records: this.records.values().toArray().toString(),
    });
  }

  /**
   * Read the current record for a dataKey, or undefined if nothing is stored.
   */
  get(dataKey: string): RealtimeDataRecord | undefined {
    return this.records.get(dataKey);
  }

  /**
   * All dataKeys currently owned by a given data connector (dataSet). Used when
   * a connector stops, so its keys can be cleared and its widgets notified.
   */
  getKeysByDataSetId(dataSetId: number): string[] {
    const keys: string[] = [];
    for (const record of this.records.values()) {
      if (record.dataSetId === dataSetId) {
        keys.push(record.dataKey);
      }
    }
    return keys;
  }

  /**
   * Drop all data written by a given data connector (dataSet).
   */
  deleteByDataSetId(dataSetId: number): void {
    for (const [dataKey, record] of Array.from(this.records)) {
      if (record.dataSetId === dataSetId) {
        this.records.delete(dataKey);
      }
    }
  }

  /**
   * Drop everything. Used on purgeAll.
   */
  deleteAll(): void {
    this.records.clear();
  }
}

export const realtimeDataStore = new RealtimeDataStore();
