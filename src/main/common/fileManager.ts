import axios from "axios";
import fs from 'fs';
import { join } from 'path';
import { app } from "electron";
import * as cheerio from 'cheerio';
import 'dotenv/config';

import { FileStore } from "./fileStore";
import { Config } from "../config/config";
import { State } from "./state";
import { LocalFile, RequiredFile } from "./types";

const state = new State();
const config = new Config(app, process.platform, state);
const xiboLibDir = config.getSetting('library');
const store = new FileStore(config.dbPath)

export type FileManagerFileType =  RequiredFile & {
    localPath: string;
    status: 'success' | 'failed' | 'skipped' | 'updated';
    lastDownloaded: string;
};

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
        if (existing && existing.status === 'success') {
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
    return store.db.prepare(`SELECT * FROM files WHERE fileId = ? AND type = 'layout'`).get(String(layoutId)) as LocalFile | undefined;
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
    const resourceSaveAs = `layout_${file.layoutId}_region_${file.regionId}_media_${file.mediaId}`;
    const saveAs = resourceSaveAs + '.html';
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
    }

    return file;
}
