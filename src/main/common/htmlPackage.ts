/*
 * Copyright (c) 2026 Xibo Signage Ltd
 *
 * Xibo - Digital Signage - https://xibosignage.com
 *
 * This file is part of Xibo.
 *
 * Xibo is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * any later version.
 *
 * Xibo is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Xibo.  If not, see <http://www.gnu.org/licenses/>.
 */
/**
 * HTML Package (.htz) support.
 *
 * An HTML Package is a zip archive holding a self-contained web page. The CMS
 * ships it as an ordinary media file, so it arrives through the normal required
 * files flow and is written to the library directory like any other download.
 *
 * To render it we extract the archive into a directory beside it:
 *
 *     <library>/html-package/<storedAs>/...
 *
 * The local file server already serves the whole library directory as static
 * content (see createFileServer in ../express.ts), so the extracted files are
 * reachable at http://localhost:9696/files/html-package/<storedAs>/<file>
 * without a route of their own. Serving from that one origin is what lets the
 * package's own relative links resolve and keeps xiboIC working from inside it.
 */
import fs from 'fs';
import { join, sep } from 'path';
import { unzipSync } from 'fflate';

import { htmlPackageDirName } from '../../shared/htmlPackage';

export { htmlPackageDirName, isHtmlPackage } from '../../shared/htmlPackage';

/** Directory one package is extracted into. */
export function htmlPackageDir(libraryDir: string, saveAs: string): string {
    return join(libraryDir, htmlPackageDirName, saveAs);
}

/**
 * Normalise a zip entry path and reject anything that would escape its package
 * directory.
 *
 * Archive paths are attacker-controlled as far as the player is concerned: an
 * entry named `../../index.html` would otherwise be written outside the package
 * directory, anywhere the player can write. Returns null for a path we will not
 * extract.
 */
function safeEntryPath(rawPath: string): string | null {
    // Archives built on Windows can carry backslash separators.
    const path = rawPath.replace(/\\/g, '/');

    // Directory entries carry no content of their own.
    if (path.length === 0 || path.endsWith('/')) {
        return null;
    }

    // An absolute path is not relative to the package root.
    if (path.startsWith('/')) {
        return null;
    }

    const segments = path.split('/');

    for (const segment of segments) {
        // '' catches a doubled separator, '..' an attempt to climb out, and '.'
        // is simply noise. A colon would be a Windows drive or stream specifier.
        if (segment === '' || segment === '.' || segment === '..' || segment.includes(':')) {
            return null;
        }
    }

    return segments.join('/');
}

/**
 * Entries an archiver adds that are not part of the package.
 *
 * These matter because they are extra top-level entries: left in, they would
 * hide the fact that a package is wrapped in a single directory, and
 * packageRootDir() below would not be able to unwrap it.
 */
function isArchiverJunk(entryPath: string): boolean {
    const segments = entryPath.split('/');
    const basename = segments[segments.length - 1];

    return segments.includes('__MACOSX')
        || basename === '.DS_Store'
        || basename === 'Thumbs.db'
        || basename === 'desktop.ini'
        // AppleDouble resource forks.
        || basename.startsWith('._');
}

/**
 * The single directory every entry sits under, if there is one.
 *
 * Compressing a *folder* rather than its contents is the easy mistake to make,
 * and it produces an archive where everything is one level down —
 * `hello-world/index.html` instead of `index.html`. The nominated file would
 * then never be found and the widget would render blank, so the wrapper is
 * stripped on the way in. Returns null when any entry already sits at the root,
 * or when entries disagree about the top-level directory, since in either case
 * there is no single wrapper to remove.
 */
function packageRootDir(entryPaths: string[]): string | null {
    if (entryPaths.length === 0) {
        return null;
    }

    let root: string | null = null;

    for (const entryPath of entryPaths) {
        const segments = entryPath.split('/');

        // An entry at the archive root means the package is not wrapped.
        if (segments.length < 2) {
            return null;
        }

        if (root === null) {
            root = segments[0];
        } else if (segments[0] !== root) {
            return null;
        }
    }

    return root;
}

/**
 * Extract an already-downloaded HTML Package archive.
 *
 * Replaces any previous extraction wholesale, so a re-downloaded archive cannot
 * leave a stale asset behind to be served in preference to nothing. Returns
 * true only when the package is extracted and ready to serve; the caller should
 * treat false as "this file is not usable" and let the next collection retry.
 *
 * Every failure path leaves the package directory absent rather than stale or
 * half-written, which is also what tells downloadFile it has to extract again.
 */
export function extractPackage(
    libraryDir: string,
    saveAs: string,
    archivePath: string,
): boolean {
    const targetDir = htmlPackageDir(libraryDir, saveAs);

    try {
        const archive = fs.readFileSync(archivePath);

        // Synchronous by design: this runs during collection rather than during
        // playback, and it keeps the download-then-extract sequence atomic from
        // the caller's point of view.
        const entries = unzipSync(new Uint8Array(archive));

        const files: Array<{ path: string; data: Uint8Array }> = [];

        for (const rawPath of Object.keys(entries)) {
            const path = safeEntryPath(rawPath);

            if (path === null) {
                // Only worth a line in the log when it looks like an escape
                // attempt rather than an ordinary directory entry.
                if (!rawPath.endsWith('/')) {
                    console.warn('[HtmlPackage] extract: skipped unsafe entry', {
                        saveAs,
                        entry: rawPath,
                        method: 'HtmlPackage::extractPackage',
                    });
                }
                continue;
            }

            if (isArchiverJunk(path)) {
                continue;
            }

            files.push({ path, data: entries[rawPath] });
        }

        if (files.length === 0) {
            console.error('[HtmlPackage] extract: archive holds no usable files', {
                saveAs,
                method: 'HtmlPackage::extractPackage',
            });
            // Leave nothing from a previous revision behind to be served.
            removePackage(libraryDir, saveAs);
            return false;
        }

        // Unwrap an archive that is a compressed folder rather than compressed
        // contents, so the nominated file is where the CMS says it is.
        const rootDir = packageRootDir(files.map((entry) => entry.path));

        if (rootDir !== null) {
            const prefixLength = rootDir.length + 1;

            for (const entry of files) {
                entry.path = entry.path.slice(prefixLength);
            }

            console.debug('[HtmlPackage] extract: unwrapped single root directory', {
                saveAs,
                rootDir,
                method: 'HtmlPackage::extractPackage',
            });
        }

        // Replace, do not merge.
        removePackage(libraryDir, saveAs);
        fs.mkdirSync(targetDir, { recursive: true });

        for (const entry of files) {
            const destination = join(targetDir, ...entry.path.split('/'));

            // Belt and braces: the entry path was already validated, so this
            // should never fire, but writing outside the package directory is
            // not a failure mode worth risking on one check.
            if (!destination.startsWith(targetDir + sep)) {
                console.warn('[HtmlPackage] extract: refused entry outside package dir', {
                    saveAs,
                    entry: entry.path,
                    method: 'HtmlPackage::extractPackage',
                });
                continue;
            }

            fs.mkdirSync(join(destination, '..'), { recursive: true });
            fs.writeFileSync(destination, entry.data);
        }

        console.debug('[HtmlPackage] extract: done', {
            saveAs,
            entries: files.length,
            targetDir,
            method: 'HtmlPackage::extractPackage',
        });

        return true;
    } catch (err) {
        console.error('[HtmlPackage] extract: failed', {
            saveAs,
            archivePath,
            err,
            method: 'HtmlPackage::extractPackage',
        });

        // Leave nothing half-extracted behind to be served.
        removePackage(libraryDir, saveAs);

        return false;
    }
}

/** Remove one package's extracted directory. */
export function removePackage(libraryDir: string, saveAs?: string | null): void {
    if (!saveAs) {
        return;
    }

    const targetDir = htmlPackageDir(libraryDir, saveAs);

    try {
        if (fs.existsSync(targetDir)) {
            fs.rmSync(targetDir, { recursive: true, force: true });
        }
    } catch (err) {
        console.warn('[HtmlPackage] removePackage: failed', {
            saveAs,
            targetDir,
            err,
            method: 'HtmlPackage::removePackage',
        });
    }
}

/** Remove every extracted package. Used by the full purge. */
export function removeAllPackages(libraryDir: string): void {
    const root = join(libraryDir, htmlPackageDirName);

    try {
        if (fs.existsSync(root)) {
            fs.rmSync(root, { recursive: true, force: true });
        }
    } catch (err) {
        console.warn('[HtmlPackage] removeAllPackages: failed', {
            root,
            err,
            method: 'HtmlPackage::removeAllPackages',
        });
    }
}
