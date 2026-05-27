import Database from "better-sqlite3";
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { DateTime } from 'luxon';

import { LogAlertEventType, LogAlertType, LogCategoryType } from "../loggerLib";
import { LogsThreshold } from "../../main/common/types";

export type AppContext = 'main' | 'renderer';

export interface LogEntry {
  id?: number;
  uid: string;
  level: string;
  message: string;
  timestamp: number;
  context: AppContext;
  method?: string;
  scheduleId?: number;
  layoutId?: number;
  mediaId?: number;
  category?: LogCategoryType;
  eventType?: LogAlertEventType;
  alertType?: LogAlertType;
  refId?: number;
  log?: Record<string, any>
  code?: string;
  count?: number;
  date?: string;
  expires?: string;
  regionId?: number;
  widgetId?: number;
}

export class ConsoleDB {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private dedupFaultStmt: Database.Statement;
  private activeFaultForLayoutStmt: Database.Statement;

  // In-memory mirrors so the status window never touches SQLite.
  private _count: number = 0;
  private _recentLogs: LogEntry[] = []; // most-recent-first, non-Fault, max 5

  constructor() {
    const userDataPath = app.getPath('userData');
    const logsDir = path.join(userDataPath, 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

    const dbPath = path.join(logsDir, 'console-logs.db');
    const tableName = 'logs';
    this.db = new Database(dbPath);

    // WAL mode allows concurrent readers and a single writer without full database locks.
    // busy_timeout retries for up to 5s before throwing SQLITE_BUSY, preventing
    // transient lock errors from stale journal files or brief write contention.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');

    this.db
      .exec(
        `CREATE TABLE IF NOT EXISTS ${tableName} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uid TEXT,
          level TEXT,
          message TEXT,
          timestamp INTEGER,
          context TEXT,
          method TEXT,
          scheduleId INTEGER,
          layoutId INTEGER,
          mediaId INTEGER,
          category TEXT,
          eventType TEXT,
          alertType TEXT,
          refId INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_logs_category ON ${tableName} (category);
        CREATE INDEX IF NOT EXISTS idx_logs_category_ts ON ${tableName} (category, timestamp DESC);`
      );

    // Get existing columns in the logs table
    const existingColumnsStmt = this.db.prepare(`PRAGMA table_info(${tableName})`);
    const existingColumns = existingColumnsStmt.all().map((col: any) => col.name);

    // If new columns don't exist, add them to the table
    const newColumns = [
      { name: 'code', type: 'TEXT' },
      { name: 'count', type: 'INTEGER' },
      { name: 'date', type: 'TEXT' },
      { name: 'expires', type: 'TEXT' },
      { name: 'regionId', type: 'INTEGER' },
      { name: 'widgetId', type: 'INTEGER' },
    ];
    newColumns.forEach(column => {
      if (!existingColumns.includes(column.name)) {
        // Note: Columns names cannot be parameterized in DDL statements, so we need to interpolate them directly into the query string
        this.db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${column.name} ${column.type}`).run();
      }
    });

    this.insertStmt = this.db.prepare(`
      INSERT INTO logs (uid, level, message, timestamp, context, method, scheduleId, layoutId, mediaId, category, eventType, alertType, refId, code, count, date, expires, regionId, widgetId)
      VALUES (@uid, @level, @message, @timestamp, @context, @method, @scheduleId, @layoutId, @mediaId, @category, @eventType, @alertType, @refId, @code, @count, @date, @expires, @regionId, @widgetId)
    `);

    // Prepared after migrations so all columns (code, regionId, widgetId, scheduleId) are guaranteed to exist
    this.dedupFaultStmt = this.db.prepare(`
      SELECT id FROM logs
      WHERE category = 'Fault'
        AND code IS ?
        AND layoutId IS ?
        AND regionId IS ?
        AND widgetId IS ?
        AND mediaId IS ?
        AND scheduleId IS ?
        AND (expires IS NULL OR expires > ?)
      LIMIT 1
    `);

    // Seed the in-memory count once at startup — the only DB read needed for count().
    this._count = (this.db.prepare('SELECT COUNT(*) as count FROM logs').get() as { count: number }).count;
    this.activeFaultForLayoutStmt = this.db.prepare(`
      SELECT id FROM logs
      WHERE category = 'Fault'
        AND layoutId = ?
        AND (expires IS NULL OR expires > ?)
      LIMIT 1
    `);
  }

  insert(entry: LogEntry) {
    this.insertStmt.run({
      uid: entry.uid,
      level: entry.level,
      message: entry.message,
      timestamp: entry.timestamp,
      context: entry.context,
      method: entry.method || null,
      scheduleId: entry.scheduleId || null,
      layoutId: entry.layoutId || null,
      mediaId: entry.mediaId || null,
      category: entry.category || null,
      eventType: entry.eventType || null,
      alertType: entry.alertType || null,
      refId: entry.refId || null,
      code: entry.code || null,
      count: entry.count || null,
      date: entry.date || null,
      expires: entry.expires || null,
      regionId: entry.regionId || null,
      widgetId: entry.widgetId || null,
    });

    this._count++;

    console._log('[ConsoleDB::insert] - Debugging', {
      category: entry.category,
      ...entry,
    })
    if (entry.category !== 'Fault') {
      this._recentLogs.unshift(entry);
      if (this._recentLogs.length > 5) this._recentLogs.pop();
    }
  }

  count() {
    return this._count;
  }

  getLogsByCategory(category: LogCategoryType, limit: number = LogsThreshold): LogEntry[] {
    if (!category) {
      const stmt = this.db.prepare(`SELECT * FROM logs ORDER BY timestamp DESC LIMIT ?`);

      return stmt.all(limit) as LogEntry[];
    }


    const stmt = this.db.prepare(`SELECT * FROM logs WHERE category = ? ORDER BY timestamp DESC LIMIT ?`);

    if (category === 'Error') {
      const errorStmt = this.db.prepare(`SELECT * FROM logs WHERE category = 'event' OR category = ? ORDER BY timestamp DESC LIMIT ?`);

      return errorStmt.all(category, limit) as LogEntry[];
    } else if (category === 'Off') {
      return stmt.all('event', limit) as LogEntry[];
    } else {
      return stmt.all(category, limit) as LogEntry[];
    }
  }

  /**
   * Returns the most recent log entries across all categories except Fault.
   * Served from the in-memory ring buffer — no DB query.
   */
  getRecentLogs(limit = 5): LogEntry[] {
    return this._recentLogs.slice(0, limit);
  }

  deleteLogs(logs: LogEntry[]) {
    const idsToDelete = logs.reduce((ids: number[], log) => [...ids, log.id as number], []);

    const placeholders = idsToDelete.map(() => '?').join(',');
    const result = this.db.prepare(`DELETE FROM logs WHERE id IN (${placeholders})`).run(...idsToDelete);
    this._count = Math.max(0, this._count - result.changes);
  }

  /**
   * Deletes all log entries from the logs table.
   */
  deleteAllLogs() {
    this.db.prepare('DELETE FROM logs').run();
  }

  deleteLogsByCategory(logCategory: LogCategoryType) {
    if (!logCategory) {
      return;
    }

    const result = this.db.prepare(`DELETE FROM logs WHERE category = ?`).run(logCategory);
    this._count = Math.max(0, this._count - result.changes);
  }

  /**
   * Returns true if a non-expired Fault entry already exists for the given key combination.
   * Uses SQLite IS operator for NULL-safe equality on nullable ID columns.
   */
  faultExists(
    code: string | null,
    ids: {
      layoutId?: number | null;
      regionId?: number | null;
      widgetId?: number | null;
      mediaId?: number | null;
      scheduleId?: number | null;
    }
  ): boolean {
    const now = DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss');
    const result = this.dedupFaultStmt.get(
      code ?? null,
      ids.layoutId ?? null,
      ids.regionId ?? null,
      ids.widgetId ?? null,
      ids.mediaId ?? null,
      ids.scheduleId ?? null,
      now
    );
    return result !== undefined;
  }

  /**
   * Returns true if the layout has any active (non-expired) fault.
   */
  hasActiveFaultForLayout(layoutId: number): boolean {
    const now = DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss');
    const result = this.activeFaultForLayoutStmt.get(layoutId, now);
    return result !== undefined;
  }

  deleteExpiredByCategory(logCategory: LogCategoryType) {
    if (!logCategory) {
      return;
    }

    const now = DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss');
    const result = this.db.prepare(
      `DELETE FROM logs WHERE category = ? AND expires IS NOT NULL AND expires < ?`
    ).run(logCategory, now);
    this._count = Math.max(0, this._count - result.changes);
  }
}