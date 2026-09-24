import Database from "better-sqlite3";
import { FileManagerFileType } from "./fileManager";
import { LocalFile } from "./types";

// One entry of the CMS required files list, as stored.
export type ListedFile = {
    name: string;
    url: string;
    fileId: string;
    type: string;
    fileType: string;
    code: string | null;
    listedMd5: string;
    listedSize: number;
    listedUpdated: string | null;
    updateInterval: number | null;
    layoutId: number | null;
};

export class FileStore {
    db: Database.Database;
    private insertStmt: Database.Statement;
    private updateStmt: Database.Statement;
    private upsertListedStmt: Database.Statement;

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

        // Columns added after the first release. SQLite takes one ALTER per column.
        const existingColumns = new Set(
            (this.db.prepare(`PRAGMA table_info(files)`).all() as { name: string }[]).map(col => col.name)
        );

        const addedColumns: [string, string][] = [
            ['code', 'TEXT'],
            ['listedMd5', 'TEXT'],
            ['listedSize', 'INTEGER'],
            ['listedUpdated', 'TEXT'],
            ['updateInterval', 'INTEGER'],
            ['layoutId', 'INTEGER'],
            ['lastListedAt', 'TEXT'],
        ];

        for (const [column, columnType] of addedColumns) {
            if (!existingColumns.has(column)) {
                this.db.exec(`ALTER TABLE files ADD COLUMN ${column} ${columnType}`);
            }
        }

        // Indexes for the lookups that run on every assessment pass.
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_files_type_layout ON files(type, layoutId)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_files_last_listed ON files(lastListedAt)`);

        this.insertStmt = this.db.prepare<LocalFile>(`
            INSERT INTO files (name, url, localPath, size, status, fileId, type, fileType, md5, code)
            VALUES (@name, @url, @localPath, @size, @status, @fileId, @type, @fileType, @md5, @code)
            ON CONFLICT(name) DO UPDATE SET
                url = excluded.url,
                localPath = excluded.localPath,
                size = excluded.size,
                status = excluded.status,
                type = excluded.type,
                fileType = excluded.fileType,
                md5 = excluded.md5,
                code = excluded.code,
                lastDownloaded = CURRENT_TIMESTAMP
        `);

        this.updateStmt = this.db.prepare<LocalFile>(`
            UPDATE files SET
                url = @url,
                localPath = @localPath,
                size = @size,
                status = @status,
                md5 = @md5,
                code = @code,
                lastDownloaded = CURRENT_TIMESTAMP
            WHERE name = @name
        `);

        // Writes only what the CMS told us. The download details (status, localPath,
        // size, md5, lastDownloaded) are set when the file actually arrives.
        this.upsertListedStmt = this.db.prepare<ListedFile & { lastListedAt: string }>(`
            INSERT INTO files (
                name, url, fileId, type, fileType, code,
                listedMd5, listedSize, listedUpdated, updateInterval, layoutId, lastListedAt,
                status, localPath, size, md5, lastDownloaded
            )
            VALUES (
                @name, @url, @fileId, @type, @fileType, @code,
                @listedMd5, @listedSize, @listedUpdated, @updateInterval, @layoutId, @lastListedAt,
                'pending', '', 0, '', NULL
            )
            ON CONFLICT(name) DO UPDATE SET
                url = excluded.url,
                fileId = excluded.fileId,
                type = excluded.type,
                code = excluded.code,
                listedMd5 = excluded.listedMd5,
                listedSize = excluded.listedSize,
                listedUpdated = excluded.listedUpdated,
                updateInterval = excluded.updateInterval,
                layoutId = excluded.layoutId,
                lastListedAt = excluded.lastListedAt
        `);
    }

    insert(file: FileManagerFileType) {
        return this.insertStmt.run({
            name: file.saveAs,
            url: file.path,
            localPath: file.localPath,
            size: file.size,
            status: file.status,
            fileId: file.id,
            type: file.type,
            fileType: file.fileType,
            md5: file.md5,
            code: file.code ?? null,
        });
    }

    update(file: FileManagerFileType) {
        return this.updateStmt.run({
            name: file.saveAs,
            url: file.path,
            localPath: file.localPath,
            size: file.size,
            status: file.status,
            md5: file.md5,
            code: file.code ?? null,
        });
    }

    // Stores the required files list, stamping every row with the same list time.
    saveListed(files: ListedFile[], lastListedAt: string) {
        const save = this.db.transaction((items: ListedFile[]) => {
            for (const item of items) {
                this.upsertListedStmt.run({ ...item, lastListedAt });
            }
        });

        save(files);
    }

    // Rows missing from the most recent list, including those never listed.
    getNotListedAt(lastListedAt: string): LocalFile[] {
        return this.db.prepare(`
            SELECT * FROM files WHERE lastListedAt IS NULL OR lastListedAt != ?
        `).all(lastListedAt) as LocalFile[];
    }

    // Widget HTML rows the CMS listed for this layout, whatever their status.
    getListedResourcesForLayout(layoutId: number, lastListedAt: string): LocalFile[] {
        return this.db.prepare(`
            SELECT * FROM files
            WHERE type = 'resource' AND layoutId = ? AND lastListedAt = ?
        `).all(layoutId, lastListedAt) as LocalFile[];
    }

    // The stamp carried by the most recently stored list.
    getLatestListedAt(): string | null {
        const row = this.db.prepare(`
            SELECT MAX(lastListedAt) AS latest FROM files
        `).get() as { latest: string | null } | undefined;

        return row?.latest ?? null;
    }

    getByFileId(fileId: number): FileManagerFileType | undefined {
        return this.db.prepare(`
            SELECT * FROM files
            WHERE type = 'widget' AND fileId = ? AND status IN ('success', 'updated')
        `).get(`${fileId}`) as FileManagerFileType | undefined;
    }

    getByStoredAs(storedAs: string): FileManagerFileType | undefined {
        return this.db.prepare(`SELECT * FROM files WHERE name = ?`).get(storedAs) as FileManagerFileType | undefined;
    }
  
    getAll(): LocalFile[] {
        return this.db.prepare(`SELECT * FROM files`).all() as LocalFile[];
    }

    deleteByStoredAs(storedAs: string): Database.RunResult {
        return this.db.prepare(`DELETE FROM files WHERE name = ?`).run(storedAs);
    }
}