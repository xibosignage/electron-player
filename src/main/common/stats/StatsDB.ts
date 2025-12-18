import Database from "better-sqlite3";
import { app } from "electron";
import { join } from 'path';
import { existsSync, mkdirSync } from "fs";

export interface StatEntry {
  id?: number;
  count?: number;
  duration?: number;
  fromdt?: string;
  layoutid?: number;
  mediaid?: number;
  scheduleid?: number;
  tag?: string;
  timestamp?: number;
  todt?: string;
  type?: 'layout' | 'widget' | 'media' | 'event';
}

export class StatsDB {
  private db: Database.Database;
  private insertStmt: Database.Statement;

  constructor() {
    const userDataPath = app.getPath('userData');
    const statsDir = join(userDataPath, 'stats');
    if (!existsSync(statsDir)) mkdirSync(statsDir, { recursive: true });

    const dbPath = join(statsDir, 'stats.db');
    this.db = new Database(dbPath);

    this.db
      .exec(
        `CREATE TABLE IF NOT EXISTS stats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scheduleid INTEGER,
          layoutid INTEGER,
          mediaid INTEGER,
          type TEXT,
          fromdt TEXT,
          todt TEXT,
          count INTEGER,
          duration INTEGER,
          timestamp INTEGER,
          tag TEXT
        )`
      );

    this.insertStmt = this.db.prepare(`
      INSERT INTO stats (scheduleid, layoutid, mediaid, type, fromdt, todt, count, duration, timestamp, tag) VALUES (@scheduleid, @layoutid, @mediaid, @type, @fromdt, @todt, @count, @duration, @timestamp, @tag)
    `);
  }

  insert(stat: StatEntry) {
    try {
    this.insertStmt.run({
      scheduleid: stat.scheduleid || null,
      layoutid: stat.layoutid || null,
      mediaid: stat.mediaid || null,
      type: stat.type || null,
      fromdt: stat.fromdt || null,
      todt: stat.todt || null,
      count: stat.count || 0,
      duration: stat.duration || 0,
      timestamp: stat.timestamp || Date.now(),
      tag: stat.tag || null,
    });
    } catch (error) {
      console.error('StatsDB insert error:', error);
    }
  }

  get(query: Partial<StatEntry>) : StatEntry | undefined {
    const conditions = Object.keys(query).map(key => `${key} = @${key}`).join(' AND ');
    const stmt = this.db.prepare(`SELECT * FROM stats WHERE ${conditions} LIMIT 1`);
    return stmt.get(query) as StatEntry | undefined;
  }

  getAll(limit = 50) : StatEntry[] {
    const rowLimit = limit > 0 ? limit : 50;
    const stmt = this.db.prepare(`SELECT * FROM stats WHERE duration > 0 ORDER BY timestamp DESC LIMIT ?`);
    return stmt.all(rowLimit) as StatEntry[];
  }

  update(id: number, stat: Partial<StatEntry>) {
    const fields = Object.keys(stat).map(key => `${key} = @${key}`).join(', ');
    const stmt = this.db.prepare(`UPDATE stats SET ${fields} WHERE id = @id`);
    return stmt.run({ ...stat, id });
  }

  deleteAll() {
    this.db.prepare(`DELETE FROM stats`).run();
  }

  bulkDeleteByIds(ids: number[]) {
    const placeholders = ids.map(() => '?').join(', ');
    const stmt = this.db.prepare(`DELETE FROM stats WHERE id IN (${placeholders})`);
    stmt.run(...ids);
  }
}