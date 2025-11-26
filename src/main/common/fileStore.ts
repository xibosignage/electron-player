import Database from "better-sqlite3";
import { FileManagerFileType } from "./fileManager";
import { LocalFile } from "./types";

export class FileStore {
    db: Database.Database;
    private insertStmt: Database.Statement;
    private updateStmt: Database.Statement;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);

        this.db.exec(`
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

        this.insertStmt = this.db.prepare<LocalFile>(`
            INSERT INTO files (name, url, localPath, size, status, fileId, type, fileType, md5)
            VALUES (@name, @url, @localPath, @size, @status, @fileId, @type, @fileType, @md5)
            ON CONFLICT(name) DO UPDATE SET
                url = excluded.url,
                localPath = excluded.localPath,
                size = excluded.size,
                status = excluded.status,
                type = excluded.type,
                fileType = excluded.fileType,
                md5 = excluded.md5,
                lastDownloaded = CURRENT_TIMESTAMP
        `);

        this.updateStmt = this.db.prepare<LocalFile>(`
            UPDATE files SET
                url = @url,
                size = @size,
                status = @status,
                md5 = @md5,
                lastDownloaded = CURRENT_TIMESTAMP
            WHERE name = @name
        `);
    }

    insert(file: FileManagerFileType) {
        this.insertStmt.run({
            name: file.saveAs,
            url: file.path,
            localPath: file.localPath,
            size: file.size,
            status: file.status,
            fileId: file.id,
            type: file.type,
            fileType: file.fileType,
            md5: file.md5,
        });
    }

    update(file: FileManagerFileType) {
        this.updateStmt.run({
            name: file.saveAs,
            url: file.path,
            size: file.size,
            status: file.status,
            md5: file.md5,
        });
    }
}