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
 * Facts about HTML Packages (.htz) that both processes need.
 *
 * Main extracts an archive into `<library>/html-package/<storedAs>/`; the
 * renderer tells XLR to load it from the matching URL under the local file
 * server. Keeping the directory name here is what stops those two drifting.
 */

/** Directory under the library that holds every extracted package. */
export const htmlPackageDirName = 'html-package';

/** Extension the CMS uses for an HTML Package (module setting `validExtensions`). */
export const htmlPackageExtension = '.htz';

/** Is this required file an HTML Package archive? */
export function isHtmlPackage(saveAs?: string | null): boolean {
    return String(saveAs ?? '').toLowerCase().endsWith(htmlPackageExtension);
}
