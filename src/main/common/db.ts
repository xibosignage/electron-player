import Database from 'better-sqlite3';
import { app } from 'electron';
import { Config } from '../config/config';
import { State } from './state';

const state = new State();
const config = new Config(app, process.platform, state);
const dbPath = config.dbPath;
const db = new Database(dbPath);

db.exec(`
    CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    url TEXT,
    localPath TEXT,
    size INTEGER,
    status TEXT,
    fileId TEXT,
    type TEXT,
    fileType TEXT,
    md5 TEXT,
    lastDownloaded DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

export default db;
