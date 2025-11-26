import Database from 'better-sqlite3';
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

import { LogMessage } from './loggerLib';

export class LogStore {
  private db: Database.Database;
  private insertStmt: Database.Statement;

  constructor() {
    const userDataPath = app.getPath('userData');
    const logsDir = path.join(userDataPath, 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

    const dbPath = path.join(logsDir, 'player-logs.db');
    this.db = new Database(dbPath);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT,
        message TEXT,
        level TEXT,
        context TEXT,
        method TEXT,
        scheduleId INTEGER,
        layoutId INTEGER,
        mediaId INTEGER,
        eventType TEXT,
        alertType TEXT,
        refId INTEGER,
        timestamp INTEGER,
        date DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    this.insertStmt = this.db.prepare(`
      INSERT INTO logs (uid, message, level, context, method, scheduleId, layoutId, mediaId, eventType, alertType, refId, timestamp)
      VALUES (@uid, @message, @level, @context, @method, @scheduleId, @layoutId, @mediaId, @eventType, @alertType, @refId, @timestamp)
    `);
  }

  insert(log: LogMessage) {
    this.insertStmt.run({
      uid: log.uid,
      message: JSON.stringify(log.message),
      level: log.level,
      context: log.context,
      method: log.method,
      scheduleId: log.scheduleId,
      layoutId: log.layoutId,
      mediaId: log.mediaId,
      eventType: log.eventType,
      alertType: log.alertType,
      refId: log.refId,
      timestamp: log.timestamp,
    });
  }

  getRecent(limit = 100) {
    return this.db.prepare(`
      SELECT * FROM logs
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit);
  }

  clear() {
    this.db.exec(`DELETE FROM logs;`);
  }
}
