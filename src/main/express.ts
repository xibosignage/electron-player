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
import express from 'express';
import corsImport from 'cors';
import fs from 'fs/promises';
import fsSync from 'fs';
import { BrowserWindow, app } from 'electron';
import { DateTime } from 'luxon';

import { Config } from './config/config';
import { Faults } from '../shared/faults/Faults';
import { scheduleCriteriaManager } from '../shared/scheduleCriteria/scheduleCriteriaManager';
import { realtimeDataStore } from './dataConnector/realtimeDataStore';

const cors = (corsImport as any).default ?? corsImport;
const port = 9696;
let isListening = false;

export async function createFileServer(config: Config, mainWindow: BrowserWindow, faults: Faults) {
  const server = express();
  // Use the cors middleware
  server.use(cors());

  // Parse JSON request bodies
  server.use(express.json());

  const xiboLibDir = config.getSetting('library');

  // Ensure the library path exists
  if (!fsSync.existsSync(xiboLibDir)) {
    await fs.mkdir(xiboLibDir, { recursive: true });
  }

  server.get('/', (_req, res) => {
    res.send('Hello World!');
  });

  // Optional: list all files if /files/ is accessed directly
  server.get('/files', (_req, res) => {
    const files = fsSync.readdirSync(xiboLibDir);
    res.json({
      files,
      count: files.length,
      message: 'Use /files/<filename> to access individual files',
    });
  });

  server.use('/files', express.static(xiboLibDir));

  // ─── Local Player API ──────────────────────────────────────────────────────── 

  /**
   * Returns non-sensitive player info.
   */
  server.get('/info', (_req, res) => {
    console.debug('[FileServer::info] > Returning player info');
    res.json({
      version: app.getVersion(),
      displayName: config.displayName ?? '',
      hardwareKey: config.hardwareKey ?? '',
      screenWidth: config.state.width,
      screenHeight: config.state.height,
      longitude: config.state.longitude ?? 0,
      latitude: config.state.latitude ?? 0,
      timeZone: config.state.timeZone ?? '',
      currentLayoutId: config.state.currentLayoutId,
      displayStatus: config.state.displayStatus,
    });
  });

  /**
   * Dispatches a trigger code to XLR. Optionally targets a specific widget by ID.
   */
  server.post('/trigger', (req, res) => {
    const { trigger, id } = req.body ?? {};
    if (!trigger) {
      res.status(400).json({ success: false, error: 'trigger is required' });
      return;
    }
    console.debug('[FileServer::trigger] > Dispatching trigger to XLR', { trigger, id });
    const payload: { triggerCode: string; widgetId?: string } = { triggerCode: trigger, widgetId: undefined };
    if (id != null) payload.widgetId = String(id);
    mainWindow.webContents.send('trigger-webhook', payload);
    res.json({ success: true });
  });

  /**
   * Immediately expires a widget's duration via XLR.
   */
  server.post('/duration/expire', (req, res) => {
    const { id } = req.body ?? {};
    if (id == null) {
      res.status(400).json({ success: false, error: 'id is required' });
      return;
    }
    console.debug('[FileServer::expireWidget] > Expiring widget', { id });
    mainWindow.webContents.send('xlr-expire-widget', String(id));
    res.json({ success: true });
  });

  /**
   * Extends a widget's remaining duration by the given number of seconds via XLR.
   */
  server.post('/duration/extend', (req, res) => {
    const { id, duration } = req.body ?? {};
    if (id == null || duration == null || !Number.isFinite(Number(duration))) {
      res.status(400).json({ success: false, error: 'id is required and duration must be a valid number' });
      return;
    }
    console.debug('[FileServer::extendWidgetDuration] > Extending widget duration', { id, duration });
    mainWindow.webContents.send('xlr-extend-widget-duration', String(id), Number(duration));
    res.json({ success: true });
  });

  /**
   * Sets a widget's duration to a specific value in seconds via XLR.
   */
  server.post('/duration/set', (req, res) => {
    const { id, duration } = req.body ?? {};
    if (id == null || duration == null || !Number.isFinite(Number(duration))) {
      res.status(400).json({ success: false, error: 'id is required and duration must be a valid number' });
      return;
    }
    console.debug('[FileServer::setWidgetDuration] > Setting widget duration', { id, duration });
    mainWindow.webContents.send('xlr-set-widget-duration', String(id), Number(duration));
    res.json({ success: true });
  });

  /**
   * Retrieves data from the player's real-time data store by dataKey.
   *
   * Data connectors (running in sandboxed iframes in the renderer) publish data
   * which is forwarded to the main process and held in `realtimeDataStore`.
   * Real-time widgets read it back through here via xiboIC.getData, using a
   * relative `/realtime` URL that resolves against the local file server.
   *
   * A miss returns 404 (not an empty 200) so xiboIC.getData fires the widget's
   * error callback and the widget can degrade gracefully — matching the
   * ChromeOS player's service-worker behaviour.
   */
  server.get('/realtime', (req, res) => {
    const { dataKey } = req.query;
    if (!dataKey || typeof dataKey !== 'string') {
      res.status(400).json({ success: false, error: 'dataKey is required' });
      return;
    }

    const record = realtimeDataStore.get(dataKey);

    console.debug('[FileServer::realtime] > Request for realtime data', { dataKey, record });

    if (!record) {
      console.debug('[FileServer::realtime] > No data for key', { dataKey });
      res.status(404).json({ success: false, error: 'No data for dataKey' });
      return;
    }

    // The connector stored this exactly as it passed it to setData; serve it
    // verbatim as JSON (the widget's data is itself a JSON string).
    const __d = (globalThis as any).__dcDiag; if (__d) { __d.getN++; __d.getBytes += record.data?.length ?? 0; } // [DIAG]
    console.debug('[FileServer::realtime] > Serving realtime data', { dataKey });
    res.status(200).type('application/json').send(record.data);
  });

  /**
   * Updates schedule criteria metrics. Accepts an array of { metric, value, ttl } entries.
   * TTL defaults to 300 seconds if not provided.
   */
  server.post('/setCriteria', (req, res) => {
    const { criteriaUpdates } = req.body ?? {};
    if (!Array.isArray(criteriaUpdates)) {
      res.status(400).json({ success: false, error: 'criteriaUpdates must be an array' });
      return;
    }

    console.debug('[FileServer::setCriteria] > Updating criteria', { count: criteriaUpdates.length });
    let updated = 0;
    for (const entry of criteriaUpdates) {
      const { metric, value, ttl } = entry ?? {};
      if (!metric || value == null) {
        res.status(400).json({ success: false, error: 'metric and value are required' });
        return;
      }
      scheduleCriteriaManager.addOrReplace(metric, value, ttl ?? 300);
      updated++;
    }

    res.json({ success: true, updated });
  });

  /**
   * Localhost-only. Reports a fault to the player, forwarded to CMS via XMDS.
   * Intended for widgets running locally to report errors back to the player.
   */
  server.post('/fault', (req, res) => {
    const ip = req.ip ?? '';
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }

    const { code, key, reason, ttl } = req.body ?? {};
    if (code == null || !key || !reason || ttl == null) {
      res.status(400).json({ success: false, error: 'code, key, reason and ttl are required' });
      return;
    }

    console.debug('[FileServer::fault] > Reporting fault to player', { code, key, reason, ttl });
    const expires = DateTime.now().plus({ seconds: Number(ttl) }).toFormat('yyyy-MM-dd HH:mm:ss');
    const faultData: any = { code: Number(code), reason, expires };

    if (String(key).includes('_')) {
      const parts = String(key).split('_');
      const widgetId = parseInt(parts[1], 10);
      if (!isNaN(widgetId)) {
        faultData.widgetId = widgetId;
      }
    }

    faults.emitter.emit('message', faultData);
    res.json({ success: true });
  });

  if (!isListening) {
    server.listen(port, () => {
      isListening = true;
      console.log(`Xibo File Server listening on port ${port}`);
    });
  }
}
