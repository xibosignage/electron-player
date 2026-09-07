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
import { BrowserWindow } from 'electron';

import { Config } from '../config/config';
import { Xmds, validateAndRegister } from '../xmds/xmds';
import ScheduleManager from '../common/scheduleManager';
import { ConsoleDB } from '../../shared/console/ConsoleDB';
import { PoPStats } from '../common/stats/PoPStats';
import { submitStatXmlString } from '../common/parser';
import { purgeAll, clearScheduleCache, setIsPurging } from '../common/fileManager';
import { realtimeDataStore } from '../dataConnector/realtimeDataStore';
import { FaultCodes } from '../../shared/faults/Faults';

export interface CmsTransferDeps {
  config: Config;
  xmds: Xmds;
  manager: ScheduleManager;
  mainWindow: BrowserWindow;
  db: ConsoleDB;
  popStats: PoPStats;
  setPendingScheduleRefresh: (value: boolean) => void;
}

let cmsTransferInProgress = false;

/**
 * A CMS address/key we're willing to transfer to. A transfer purges the library and
 * re-registers, so the target has to be a real, non-blank string before any of that starts.
 */
export function isValidCmsTarget(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Time-boxed best-effort flush of any queued logs/stats to the CMS we're about to leave. */
async function flushToOldCms(deps: Pick<CmsTransferDeps, 'xmds' | 'db' | 'popStats'>) {
  const { xmds, db, popStats } = deps;

  const flush = async () => {
    await xmds.submitLogs(db);

    const stats = popStats.getStats(50);
    if (stats.length > 0) {
      let statsXmlString = '';
      stats.forEach((stat) => { statsXmlString += submitStatXmlString(stat); });

      const success = await xmds.submitStats(statsXmlString);
      if (success) {
        popStats.clearSubmitted(stats);
      }
    }
  };

  try {
    await Promise.race([
      flush(),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('flush timed out')), 5000)),
    ]);
  } catch (err) {
    console.debug('[CmsTransfer::flushToOldCms] Best-effort flush to old CMS did not complete', { err });
  }
}

/**
 * Transfers this display to a different CMS: validates and registers against the new CMS first,
 * and only once that succeeds purges local library/schedule/stats/logs state (since layout/
 * media/widget IDs are CMS-specific). Keeps hardwareKey/xmrChannel/macAddress/displayName
 * unchanged so the new CMS recognizes this as the same physical device. If validation/
 * registration fails, nothing on the old CMS's side was touched — config rolls back and a fault
 * is raised so the old CMS is told about the failed attempt.
 *
 * Triggered by a CMS-pushed `changeCms` XMR command, and retried on boot via
 * config.pendingCmsTransfer if a previous attempt was interrupted mid-transfer.
 */
export async function performCmsTransfer(newCmsUrl: string, newCmsKey: string, deps: CmsTransferDeps) {
  const { config, xmds, manager, mainWindow, db, popStats, setPendingScheduleRefresh } = deps;

  // Never start the destructive path on a target we can't use. An unset newCmsAddress in the
  // RegisterDisplay response used to arrive here as an xml2js attribute object, which was
  // truthy at the call site and got persisted into config as a transfer target.
  if (!isValidCmsTarget(newCmsUrl) || !isValidCmsTarget(newCmsKey)) {
    console.error('[CmsTransfer] Ignoring transfer request with an invalid CMS address/key', {
      newCmsUrl,
      newCmsKey,
    });

    // Clear any such target already on disk so it isn't retried on every boot.
    if (config.pendingCmsTransfer) {
      await config.clearPendingCmsTransfer();
    }

    return;
  }

  if (cmsTransferInProgress) {
    console.debug('[CmsTransfer] Transfer already in progress, ignoring duplicate request');
    return;
  }
  cmsTransferInProgress = true;

  const oldCmsUrl = config.cmsUrl;
  const oldCmsKey = config.cmsKey;
  const oldXmdsVersion = config.xmdsVersion;

  try {
    console.log('[CmsTransfer] Starting transfer to new CMS', { newCmsUrl });

    // Persist intent before mutating anything, so a crash mid-transfer can resume on next boot.
    await config.setPendingCmsTransfer({
      cmsUrl: newCmsUrl,
      cmsKey: newCmsKey,
      requestedAt: new Date().toISOString(),
    });

    // Pause polling against the old CMS.
    if (xmds.interval !== undefined) {
      clearInterval(xmds.interval);
    }

    // Best-effort flush of queued logs/stats to the old CMS, while we're still pointed at it.
    await flushToOldCms({ xmds, db, popStats });

    // Clear any rate-limit cooldowns accrued against the old CMS — they're keyed by method
    // name only, so a recent old-CMS 429 would otherwise silently block the new CMS too.
    xmds.clearRateLimits();

    // Point at the new CMS to validate it. hardwareKey/xmrChannel/macAddress/displayName stay
    // unchanged. Nothing destructive has happened yet, so a failure here is a clean no-op for
    // the old CMS's cache/library/logs/stats.
    config.cmsUrl = newCmsUrl;
    config.cmsKey = newCmsKey;

    // Force getSchemaVersion() to refetch, in case the new CMS runs a different XMDS schema.
    config.xmdsVersion = undefined;
    await xmds.getSchemaVersion();

    const result = await validateAndRegister(xmds);

    if (!result.success) {
      throw result.error instanceof Error ? result.error : new Error(String(result.error));
    }

    // New CMS validated and registered — now safe to tear down everything that's specific to
    // the old CMS. Show splash first so XLR transitions away from the current layout before the
    // library is wiped.
    setIsPurging(true);
    if (manager) {
      manager.layouts = [manager.getSplash()];
      manager.emitter.emit('layouts', [manager.getSplash()]);
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));

    // Logs/stats were already flushed above, so it's now safe to unconditionally clear them —
    // they reference old-CMS layout/widget IDs that are meaningless on the new CMS.
    db.deleteAllLogs();
    popStats.clearDB();

    // Purge the local library (layouts/media/widget data are CMS-specific).
    console.debug('[CmsTransfer] Clearing local library');
    await purgeAll();
    await clearScheduleCache(config.getSetting('library'));
    realtimeDataStore.deleteAll();
    mainWindow.webContents.send('update-data-connectors', []);

    // Force a full re-fetch of requiredFiles/schedule against the new CMS.
    xmds.checkRf = null;
    xmds.checkSchedule = null;
    setPendingScheduleRefresh(true);

    // Success — config was already persisted inside registerDisplay(), and the live
    // xmds.on('registered', ...) handler already reconfigured SSP/XMR for the new CMS.
    // (A "pending admin authorisation" response still resolves here, and collect()'s own
    // displayStatus gating parks the display on the splash until an admin approves it —
    // that is treated as success, not a failure requiring rollback.)
    await config.clearPendingCmsTransfer();
    config.state.cmsUrl = config.cmsUrl ?? '';
    await xmds.startInterval();

    console.log('[CmsTransfer] Transfer to new CMS completed', { newCmsUrl });
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);

    console.error('[CmsTransfer] Transfer to new CMS failed, rolling back to previous CMS', {
      newCmsUrl,
      err,
    });

    console.alert('CMS transfer failed: ' + errMessage, {
      shouldParse: false,
      eventType: 'CMS Transfer',
      alertType: 'both',
    });

    // Raise a fault so the old CMS (which we're about to roll back to) is told this display
    // tried and failed to leave for newCmsUrl — it'll go out on the next submitLogs/reportFaults.
    console.fault('CMS transfer to ' + newCmsUrl + ' failed: ' + errMessage, {
      code: FaultCodes.FaultGeneralError,
      shouldParse: false,
    });

    // Roll back in-memory config — disk config was never overwritten (registerDisplay only
    // saves on success), so the pending-transfer marker on disk still reflects the new CMS and
    // will drive a retry on the next boot. The old CMS's cache/library/logs/stats were never
    // touched, since validation now happens before any of that is torn down.
    config.cmsUrl = oldCmsUrl;
    config.cmsKey = oldCmsKey;
    config.xmdsVersion = oldXmdsVersion;

    await xmds.startInterval();
  } finally {
    setIsPurging(false);
    cmsTransferInProgress = false;
  }
}
