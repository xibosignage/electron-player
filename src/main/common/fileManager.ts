import axios from "axios";
import db from './db';
import fs from 'fs';
import { join } from 'path';
import { app } from "electron";

import { Config } from "../config/config";
import { State } from "./state";

const state = new State();
const config = new Config(app, process.platform, state);
const xiboLibDir = config.getSetting('library');

export type RequiredFileType = {
    id: string;
    download: string;
    saveAs: string;
    type: string;
    fileType: string;
    path: string;
    localPath: string;
    size: number;
    md5: string;
    status: 'success' | 'failed' | 'skipped';
    lastDownloaded: string;
};

export async function downloadFile(file: RequiredFileType) {
    const localPath = join(xiboLibDir, file.saveAs);
    let status: RequiredFileType['status'] = 'success';
    let size = 0;

    // Check if file already exists
    if (fs.existsSync(localPath)) {
        return;
        // const existing = db.prepare(`SELECT * FROM files WHERE name = ?`).get(fileName);
        // if (existing && existing.status === 'success') {
        //     console.log(`[FileManager] Skipping existing file: ${fileName}`);
        //     status = 'skipped';
        //     size = fs.statSync(localPath).size;
        //     return {
        //         name: fileName,
        //         url: fileUrl,
        //         localPath,
        //         size,
        //         status,
        //     };
        // }
    }

    try {
        console.log(`[FileManager] Downloading: ${file.path}`);
        const response = await axios.get(file.path, {
            responseType: 'arraybuffer',
            timeout: 15000, // 15s timeout
        });

        fs.writeFileSync(localPath, response.data);
        size = fs.statSync(localPath).size;

        db.prepare(`
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
        `).run(file.saveAs, file.path, localPath, size, status, file.id, file.type, file.fileType, file.md5);

        console.log(`[FileManager] Download successful: ${file.saveAs}`);
    } catch (err) {
        console.error(`[FileManager] Error downloading ${file.saveAs}:`, err);
        status = 'failed';

        // Remove partially downloaded file if exists
        if (fs.existsSync(localPath)) {
            try {
                fs.unlinkSync(localPath);
                console.log(`[FileManager] Removed incomplete file: ${file.saveAs}`);
            } catch (unlinkErr) {
                console.warn(`[FileManager] Failed to remove incomplete file: ${file.saveAs}`, unlinkErr);
            }
        }

        db.prepare(`
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

    return {
        name: file.saveAs,
        url: file.path,
        localPath,
        size,
        status,
    };
}

export function getDownloadedFiles() {
  return db.prepare(`SELECT * FROM files ORDER BY lastDownloaded DESC`).all();
}

export function getLayoutFile(layoutId: number) {
    return db.prepare(`SELECT * FROM files WHERE fileId = ? AND type = 'layout'`).get(String(layoutId));
}
