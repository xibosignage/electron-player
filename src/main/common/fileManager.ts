import axios from "axios";
import fs from 'fs';
import { join } from 'path';
import { app } from "electron";
import * as cheerio from 'cheerio';
import { DateTime } from 'luxon';
import 'dotenv/config';

import { FileStore, ListedFile } from "./fileStore";
import { Config } from "../config/config";
import { State } from "./state";
import { LocalFile, RequiredFile } from "./types";
import {
    extractPackage,
    htmlPackageDir,
    isHtmlPackage,
    removeAllPackages,
    removePackage,
} from "./htmlPackage";

const state = new State();
const config = new Config(app, process.platform, state);
const xiboLibDir = config.getSetting('library');
const store = new FileStore(config.dbPath)

export type FileManagerFileType =  RequiredFile & {
    localPath: string;
    status: 'pending' | 'success' | 'failed' | 'skipped' | 'updated';
    lastDownloaded: string;
};

// True if the file has been downloaded.
// Every file the CMS lists gets a row straight away, so having a row does not
// mean the file arrived. Only the status says that.
export function isDownloadedStatus(status?: string | null): boolean {
    return status === 'success' || status === 'updated';
}

export type PurgeItemType = {
    id: number | null;
    storedAs: string | null;
};

export let isPurging = false;

export function setIsPurging(value: boolean) {
    isPurging = value;
}

export async function downloadAndSaveFile(
    file: FileManagerFileType,
    options: {
        localPath: string;
        status: FileManagerFileType['status'];
    },
    transaction: 'insert' | 'update' = 'insert'
) {
    let status = options.status ?? 'success';
    let size = 0;
    
    try {
        console.log(`[FileManager] Downloading: ${file.path}`);
        const response = await axios.get(file.path as string, {
            responseType: 'arraybuffer',
            timeout: 15000, // 15s timeout
        });

        let fileData = response.data;

        // Rewrite local server URLs in CSS files
        if (file.fileType === 'fontCss') {
            fileData = Buffer.from(rewriteFontUrls(response.data.toString('utf-8'), (fileName) => {
                return localFileUrlFromFileName(fileName);
            }));

            console.debug('[FileManager::downloadFile] Rewrote font CSS URLs:', {
                fileData: fileData.toString('utf-8'),
            });
        }

        fs.writeFileSync(options.localPath, fileData);
        size = fs.statSync(options.localPath).size;

        // An HTML Package is not playable as a downloaded archive — it has to be
        // extracted before the renderer can point an iframe at it. Treat a
        // failed extraction as a failed download so the next collection retries.
        if (isHtmlPackage(file.saveAs)) {
            const extracted = extractPackage(
                xiboLibDir,
                file.saveAs as string,
                options.localPath,
            );

            if (!extracted) {
                throw new Error('Failed to extract HTML package ' + file.saveAs);
            }
        }

        const localFile: FileManagerFileType = {
            ...file,
            localPath: options.localPath,
            size,
            status,
            lastDownloaded: new Date().toISOString(),
        };

        if (transaction === 'insert') {
            store.insert(localFile);
        } else if (transaction === 'update') {
            store.update(localFile);
        }

        console.log(`[FileManager] Download successful: ${file.saveAs}`);
    } catch (err) {
        console.error(`[FileManager] Error downloading ${file.saveAs}:`, err);
        status = 'failed';

        // Remove partially downloaded file if exists
        if (fs.existsSync(options.localPath)) {
            try {
                fs.unlinkSync(options.localPath);
                console.log(`[FileManager] Removed incomplete file: ${file.saveAs}`);
            } catch (unlinkErr) {
                console.warn(`[FileManager] Failed to remove incomplete file: ${file.saveAs}`, unlinkErr);
            }
        }

        store.db.prepare(`
            INSERT INTO files (name, url, localPath, size, status, fileId, type, fileType, md5)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
                url = excluded.url,
                status = excluded.status,
                localPath = '',
                size = 0,
                type = '',
                fileType = '',
                md5 = '',
                lastDownloaded = CURRENT_TIMESTAMP
        `).run(file.saveAs, file.path, '', 0, status, '', '', '', '');
    }

    return file;
}

export async function downloadFile(file: FileManagerFileType) {
    const localPath = join(xiboLibDir, file.saveAs as string);

    // Check if file already exists
    if (fs.existsSync(localPath)) {
        const existing = store.db.prepare(`SELECT * FROM files WHERE name = ?`).get(file.saveAs) as FileManagerFileType | undefined;
        if (existing && isDownloadedStatus(existing.status)) {
            if (existing.md5 !== file.md5) {
                // Update local file and file meta data
                console.log(`[FileManager] Updating existing file: ${file.saveAs}`);
                console.log(`[FileManager] Updating file due to MD5 mismatch: ${file.saveAs}`);

                return await downloadAndSaveFile(file, {
                    localPath,
                    status: 'updated',
                }, 'update');
            }

            console.log('[FileManager] Existing file MD5 matches, skipping download of existing file:', {
                storedMd5: existing.md5,
                fileMd5: file.md5,
                fileName: file.saveAs,
                method: 'FileManager::downloadFile',
            });

            // The archive is unchanged, but its extracted copy may not be there
            // — a library cleared by hand, or an interrupted extraction. Put it
            // back rather than serving a package directory that does not exist.
            if (isHtmlPackage(file.saveAs) &&
                !fs.existsSync(htmlPackageDir(xiboLibDir, file.saveAs as string))
            ) {
                console.log('[FileManager] Re-extracting HTML package with no extracted copy:', {
                    fileName: file.saveAs,
                    method: 'FileManager::downloadFile',
                });
                extractPackage(xiboLibDir, file.saveAs as string, localPath);
            }

            // Keep metadata columns (e.g. code) in sync without re-downloading.
            if (file.code !== undefined && existing.code !== file.code) {
                store.db.prepare(`UPDATE files SET code = ? WHERE name = ?`).run(file.code, file.saveAs);
                console.debug(`[FileManager] Updated code for existing file: ${file.saveAs}`, { code: file.code });
            }

            return file;
        }
    }

    return await downloadAndSaveFile(file, {
        localPath,
        status: 'success',
    }, 'insert');
}

export function getDownloadedFiles() {
  return store.db.prepare<LocalFile[]>(`SELECT * FROM files ORDER BY lastDownloaded DESC`).all();
}

export function getLayoutFile(layoutId: number): LocalFile | undefined {
    return store.db.prepare(`
        SELECT * FROM files
        WHERE fileId = ? AND type = 'layout' AND status IN ('success', 'updated')
    `).get(String(layoutId)) as LocalFile | undefined;
}

export function getFileByName(name: string): LocalFile | undefined {
    return store.db.prepare(`SELECT * FROM files WHERE name = ?`).get(name) as LocalFile | undefined;
}

/**
 * Returns true if the named file downloaded successfully.
 */
export function isFileDownloaded(name: string): boolean {
    return isDownloadedStatus(getFileByName(name)?.status);
}

// True if any file the CMS asked for is still missing.
// The CMS checksum does not change when a download fails here, so this is what
// tells the player to ask for the file list again.
export function hasUndownloadedFiles(): boolean {
    return store.db.prepare(
        `SELECT 1 FROM files WHERE status NOT IN ('success', 'updated') LIMIT 1`
    ).get() !== undefined;
}

/**
 * The name a resource is stored under locally.
 */
export function resourceFileName(file: Pick<RequiredFile, 'layoutId' | 'regionId' | 'mediaId'>): string {
    return `layout_${file.layoutId}_region_${file.regionId}_media_${file.mediaId}.html`;
}

// The filename a required file is saved under.
export function requiredFileName(file: RequiredFile): string {
    if (file.type === 'resource') return resourceFileName(file);
    if (file.type === 'widget') return `${file.id}.json`;

    return file.saveAs ?? `${file.type}:${file.id}`;
}

// Saves the CMS file list, then clears out rows the CMS no longer asks for.
//
// A row is kept while its file is still on disk, so the player carries on playing
// what it already has. Rows with no file behind them are deleted.
//
// Call this only when the CMS reports a change, or on the first collection after
// startup. An unchanged list would just rewrite every row with the same values.
export function saveRequiredFilesList(files: RequiredFile[]) {
    if (files.length === 0) {
        return;
    }

    const lastListedAt = new Date().toISOString();

    const listed: ListedFile[] = files.map(file => ({
        name: requiredFileName(file),
        url: file.path ?? '',
        fileId: String(file.id),
        type: file.type,
        fileType: file.fileType ?? '',
        code: file.code ?? null,
        listedMd5: file.md5 ?? '',
        listedSize: Number(file.size) || 0,
        listedUpdated: file.updated ?? null,
        updateInterval: Number.isFinite(Number(file.updateInterval)) ? Number(file.updateInterval) : null,
        layoutId: file.layoutId ?? null,
    }));

    store.saveListed(listed, lastListedAt);

    for (const row of store.getNotListedAt(lastListedAt)) {
        if (row.localPath && fs.existsSync(row.localPath)) {
            continue;
        }

        store.deleteByStoredAs(row.name);

        console.debug('[FileManager] Removed unlisted file record with no local file', {
            name: row.name,
            method: 'FileManager::saveRequiredFilesList',
        });
    }
}

// Marks a file as failed, which is what makes the player try it again later.
export function markFileFailed(name: string) {
    store.db.prepare(`
        UPDATE files SET status = 'failed', localPath = '', lastDownloaded = NULL WHERE name = ?
    `).run(name);
}

// True if the widget's data was downloaded recently enough to reuse.
// Pass verifyLocalFile to also check the file is still on disk.
export function isWidgetDataFresh(
    name: string,
    updateInterval?: number,
    verifyLocalFile = false,
): boolean {
    const row = getFileByName(name);

    if (!row || !isDownloadedStatus(row.status) || !updateInterval) {
        return false;
    }

    if (verifyLocalFile && (!row.localPath || !fs.existsSync(row.localPath))) {
        return false;
    }

    const cachedAt = parseLastDownloaded(row.lastDownloaded);

    return cachedAt !== null && DateTime.utc() < cachedAt.plus({ minutes: Number(updateInterval) });
}

// The layout's widget files that are not downloaded yet.
//
// Returns nothing when no file list has been saved yet, so a player that has
// never reached its CMS carries on playing what it has.
export function getMissingLayoutWidgetFiles(layoutId: number): string[] {
    const lastListedAt = store.getLatestListedAt();

    if (lastListedAt === null) {
        return [];
    }

    const missing: string[] = [];

    for (const resource of store.getListedResourcesForLayout(layoutId, lastListedAt)) {
        if (!isDownloadedStatus(resource.status)) {
            missing.push(resource.name);
        }

        // The CMS does not tag widget data with a layout, so find it through the widget's HTML row.
        const data = getFileByName(`${resource.fileId}.json`);

        if (data !== undefined && !isDownloadedStatus(data.status)) {
            missing.push(data.name);
        }
    }

    return missing;
}

/**
 * Reads a lastDownloaded value from the files table.
 */
function parseLastDownloaded(value?: string): DateTime | null {
    if (!value) {
        return null;
    }

    const iso = DateTime.fromISO(value, { zone: 'utc' });

    if (iso.isValid) {
        return iso;
    }

    const sql = DateTime.fromSQL(value, { zone: 'utc' });

    return sql.isValid ? sql : null;
}

// True if our copy is newer than the CMS's last change to it.
// Widget HTML has no md5, so the timestamp is all there is to compare.
// Pass verifyLocalFile to also check the file is still on disk.
export function isResourceUpToDate(file: RequiredFile, verifyLocalFile = false): boolean {
    const row = getFileByName(resourceFileName(file));

    if (!row || !isDownloadedStatus(row.status)) {
        return false;
    }

    if (verifyLocalFile && (!row.localPath || !fs.existsSync(row.localPath))) {
        return false;
    }

    const updatedAt = Number(file.updated);
    const cachedAt = parseLastDownloaded(row.lastDownloaded);

    if (!Number.isFinite(updatedAt) || cachedAt === null) {
        return false;
    }

    return cachedAt.toSeconds() > updatedAt;
}

export function localFileUrlFromFileName(fileName: string) {
    return encodeURIComponent(fileName);
}

export function buildLocalFileUrl(url: string) {
    const match = url.match(/[?&]file=([^&]+)/i);

    if (match === null) return url;

    const fileValue = decodeURIComponent(match[1]);

    return localFileUrlFromFileName(fileValue);
}

export function rewriteFontUrls(cssText: string, replacerFn: (fileName: string, fullUrl: string) => string): string {
  const regex = /url\((['"]?)(https?:\/\/[^'")?]+\?file=([^&'")]+\.(?:woff2?|ttf|otf|eot|svg))[^'")]*?)\1\)/gi;
  return cssText.replace(regex, (_match, quote, fullUrl, fileName) => {
    const newUrl = replacerFn(fileName, fullUrl);
    return `url(${quote}${newUrl}${quote})`;
  });
}

export function parseHtmlResourceLinks(resourceHtml: string) {
    const $html = cheerio.load(resourceHtml);

    $html('script, link').each((_, element) => {
        const $el = $html(element);
        const attr = $el.is('script') ? 'src' : 'href';
        const url = $el.attr(attr);

        if (url) {
            const localFileUrl = buildLocalFileUrl(url);
            $el.attr(attr, localFileUrl);

            console.debug('[FileManager::downloadResourceFile] Resource URL regex match:', {
                localFileUrl,
            });
        }
    });

    return $html.html();
}

export async function downloadResourceFile(file: FileManagerFileType, resourceHtml: string) {
    const saveAs = resourceFileName(file);
    const localPath = join(xiboLibDir, saveAs);
    let status: FileManagerFileType['status'] = 'success';
    let size = 0;

    try {
        fs.writeFileSync(localPath, parseHtmlResourceLinks(resourceHtml));
        size = fs.statSync(localPath).size;

        store.db.prepare(`
            INSERT INTO files (name, url, localPath, size, status, fileId, type, fileType, md5)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
                url = excluded.url,
                localPath = excluded.localPath,
                size = excluded.size,
                status = excluded.status,
                type = excluded.type,
                fileType = excluded.fileType,
                md5 = excluded.md5,
                lastDownloaded = CURRENT_TIMESTAMP
        `).run(saveAs, localPath, localPath, size, status, file.id, file.type, 'html', '');

        console.log(`[FileManager] Download successful: ${saveAs}`);
    } catch (err) {
        console.error(`[FileManager] Error downloading resource ${saveAs}:`, err);
        status = 'failed';

        markFileFailed(saveAs);
    }

    return file;
}

export async function downloadWidgetDataFile(file: FileManagerFileType, widgetData: string, _status?: FileManagerFileType['status']) {
    const saveAs = `${file.id}.json`;
    const localPath = join(xiboLibDir, saveAs);
    let status: FileManagerFileType['status'] = _status ?? 'success';
    let size = 0;

    try {
        fs.writeFileSync(localPath, widgetData);
        size = fs.statSync(localPath).size;

        if (status === 'updated') {
            const fileUpdated = store.update({
                ...file,
                size,
                status,
                saveAs,
                localPath,
                path: localPath,
                md5: '',
            });

            console.log(`[FileManager] Updated widget data file: ${saveAs}`, {
                fileId: file.id,
                fileType: file.type,
                fileUpdateStatus: fileUpdated.changes === 1 ? 'success' : 'failed',
            });
        } else {
            const fileInsert = store.db.prepare(`
                INSERT INTO files (name, url, localPath, size, status, fileId, type, fileType, md5)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    url = excluded.url,
                    localPath = excluded.localPath,
                    size = excluded.size,
                    status = excluded.status,
                    type = excluded.type,
                    fileType = excluded.fileType,
                    md5 = excluded.md5,
                    lastDownloaded = CURRENT_TIMESTAMP
            `).run(saveAs, localPath, localPath, size, status, file.id, file.type, 'json', '');

            console.log(`[FileManager] Saved widget data file to DB: ${saveAs}`, {
                fileId: file.id,
                fileType: file.type,
                fileInsertStatus: fileInsert.changes === 1 ? 'success' : 'failed',
                fileRowId: fileInsert.lastInsertRowid,
            });
        }

        console.log(`[FileManager] Download successful: ${saveAs}`);
    } catch (err) {
        console.error(`[FileManager] Error downloading widget data ${saveAs}:`, err);
        status = 'failed';

        // The file on disk may be half written, so do not leave the row saying success.
        markFileFailed(saveAs);
    }

    return file;
}

export function findLayoutFileByCode(code: string): { layoutId: number; name: string } | null {
    const file = store.db.prepare(
        `SELECT fileId, name FROM files WHERE type = 'layout' AND status IN ('success', 'updated') AND code = ? LIMIT 1`
    ).get(code) as Pick<LocalFile, 'fileId' | 'name'> | undefined;

    if (!file) {
        console.warn(`[FileManager] findLayoutFileByCode: no layout found for code "${code}"`);
        return null;
    }

    console.debug(`[FileManager] findLayoutFileByCode: found layout`, { code, layoutId: file.fileId });

    return { layoutId: parseInt(file.fileId, 10), name: file.name };
}

export function getWidgetFile(fileId: number) {
    const localFile = store.getByFileId(fileId);
    console.debug(`[FileManager] getWidgetFile for fileId ${fileId}:`, { localFile });

    if (!localFile) {
        console.warn(`[FileManager] No local file found for widget fileId: ${fileId}`);
        return null;
    }

    return localFile;
}


export function purge(purgeList: PurgeItemType[]) {
    console.debug('[FileManager] purge: start', {
        total: purgeList.length,
        method: 'FileManager::purge',
    });

    for (const item of purgeList) {
        if (!item.storedAs) {
            console.debug('[FileManager] purge: skipped invalid item', { item, method: 'FileManager::purge' });
            continue;
        }

        const file = store.getByStoredAs(item.storedAs);

        if (!file) {
            console.debug('[FileManager] purge: file not found in DB, nothing to remove', {
                storedAs: item.storedAs,
                method: 'FileManager::purge',
            });
            continue;
        }

        // Remove from disk first. Only remove from DB if confirmed deleted.
        // If deletion fails, leave the DB record intact so the next collection interval can retry.
        if (file.localPath && fs.existsSync(file.localPath)) {
            try {
                fs.unlinkSync(file.localPath);
            } catch (err) {
                console.warn('[FileManager] purge: failed to delete file from disk, will retry in the next collection interval', {
                    localPath: file.localPath,
                    err,
                    method: 'FileManager::purge',
                });
                continue;
            }
        }

        // An HTML Package also has its extracted directory to clear.
        if (isHtmlPackage(item.storedAs)) {
            removePackage(xiboLibDir, item.storedAs);
        }

        // File is gone from disk (either just deleted, or was never there), safe to remove DB record.
        store.deleteByStoredAs(item.storedAs);

        console.debug('[FileManager] purge: removed', {
            storedAs: item.storedAs,
            localPath: file.localPath,
            method: 'FileManager::purge',
        });
    }

    console.debug('[FileManager] purge: done', { method: 'FileManager::purge' });
}

/**
 * Clears all required files from the local library directory and removes their database records.
 */
export async function purgeAll() {
    try {
        isPurging = true;

        console.debug('[FileManager] purgeAll: start', { method: 'FileManager::purgeAll' });

        const files = store.getAll();
        const failed: string[] = [];

        for (const file of files) {
            // Only attempt disk deletion if a local path is recorded and the file actually exists
            if (file.localPath && fs.existsSync(file.localPath)) {
                try {
                    fs.unlinkSync(file.localPath);
                } catch (err) {
                    // Keep the DB record so the file does not go stale
                    failed.push(file.localPath);
                    continue;
                }
            }

            // File is confirmed gone from disk (deleted just now, or was never stored), safe to remove DB record
            store.deleteByStoredAs(file.name);
        }

        // Drop every extracted HTML Package along with the archives.
        removeAllPackages(xiboLibDir);

        if (failed.length > 0) {
            console.error('[FileManager] purgeAll: some files could not be deleted from disk and were kept in the database', {
                failedFiles: failed,
                method: 'FileManager::purgeAll',
            });
        }

        console.debug('[FileManager] purgeAll: done', { method: 'FileManager::purgeAll' });
    } finally {
        // Always reset the flag, even if an unexpected error occurs mid-purge
        isPurging = false;
    }
}

/**
 * Deletes the cached requiredFiles.json/schedule.xml from the library directory. These are not
 * touched by purgeAll(), but they reference layout/media IDs from a specific CMS, so they must
 * also be cleared when transferring to a different CMS to avoid the offline cached-schedule
 * fallback replaying stale, CMS-specific IDs.
 */
export async function clearScheduleCache(libraryPath: string) {
    for (const fileName of ['requiredFiles.json', 'schedule.xml']) {
        const filePath = join(libraryPath, fileName);
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (err) {
            console.error('[FileManager] clearScheduleCache: failed to delete file', {
                filePath,
                err,
                method: 'FileManager::clearScheduleCache',
            });
        }
    }
}
