import Database from "better-sqlite3";
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

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
}

export class ConsoleDB {
  private db: Database.Database;
  private insertStmt: Database.Statement;

  constructor() {
    const userDataPath = app.getPath('userData');
    const logsDir = path.join(userDataPath, 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

    const dbPath = path.join(logsDir, 'console-logs.db');
    this.db = new Database(dbPath);

    this.db
      .exec(
        `CREATE TABLE IF NOT EXISTS logs (
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
        )`
      );

    this.insertStmt = this.db.prepare(`
      INSERT INTO logs (uid, level, message, timestamp, context, method, scheduleId, layoutId, mediaId, category, eventType, alertType, refId)
      VALUES (@uid, @level, @message, @timestamp, @context, @method, @scheduleId, @layoutId, @mediaId, @category, @eventType, @alertType, @refId)
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
    });
  }

  count() {
    const result = this.db.prepare('SELECT COUNT(*) as count FROM logs').get() as { count: number };

    return result.count;
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

  deleteLogs(logs: LogEntry[]) {
    const idsToDelete = logs.reduce((ids: number[], log) => [...ids, log.id as number], []);

    // Prepare the statement with placeholders for each ID
    const placeholders = idsToDelete.map(() => '?').join(',');
    const stmt = this.db.prepare(`DELETE FROM logs WHERE id IN (${placeholders})`);

    // Execute the statement with the array of IDs
    stmt.run(...idsToDelete);
  }
}