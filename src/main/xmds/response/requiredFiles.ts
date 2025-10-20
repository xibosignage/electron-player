/*
 * Copyright (C) 2025 Xibo Signage Ltd
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
import xml2js from 'xml2js';
import { MediaInventoryFileType } from '../../common/types';

export type PurgeItemType = {
    id: number | null;
    storedAs: string | null;
};

export type RequiredFileType = MediaInventoryFileType & {
    readonly download: string;
    readonly code?: string;
    readonly layoutId: number;
    readonly regionId: number | null;
    readonly mediaId: number | null;
    readonly updated: number | null;
    readonly updateInterval: number | null;
    readonly width: number;
    readonly height: number;
    shortPath: RequestInfo | URL;
}

/**
 * Register Required Files.
 */
export default class RequiredFiles {
    private readonly response: string;
    generated: string | undefined;
    filterFrom: string | undefined;
    filterTo: string | undefined;
    purge?: PurgeItemType[];
    files: RequiredFileType[] = [];

    constructor(response: string) {
        this.response = response;
    }

    async parse() {
        const parser = new xml2js.Parser();
        const rootDoc = await parser.parseStringPromise(this.response);

        // Get the encoded XML
        const xml = rootDoc["SOAP-ENV:Envelope"]["SOAP-ENV:Body"][0]["ns1:RequiredFilesResponse"][0].RequiredFilesXml[0]._;
        
        const doc = await parser.parseStringPromise(xml);

        // Parse out attributes.
        this.generated = doc.files.$.generated ?? '';
        this.filterFrom = doc.files.$.fitlerFrom ?? '';
        this.filterTo = doc.files.$.fitlerTo ?? '';
        this.purge = [];

        if (doc.files.file && doc.files.file.length > 0) {
            this.files = doc.files.file.reduce((a: RequiredFileType[], b) => {
                const _file = b.$;

                if (Boolean(_file.layoutid)) {
                    _file.layoutId = parseInt(_file.layoutid);
                    delete _file.layoutid;
                }

                if (Boolean(_file.regionid)) {
                    _file.regionId = parseInt(_file.regionid);
                    delete _file.regionid;
                }

                if (Boolean(_file.mediaid)) {
                    _file.mediaId = parseInt(_file.mediaid);
                    delete _file.mediaid;
                }

                return [...a, _file];
            }, []);
        }

        if (doc.files.purge && doc.files.purge.length > 0 && doc.files.purge[0] !== '') {
            this.purge = doc.files.purge.reduce((a: PurgeItemType[], b) => {
                let idAttrib: number | null = parseInt(b.$.id ?? '');
                const storedAsAttrib = b.$.storedAs;

                if (isNaN(idAttrib)) {
                    idAttrib = null;
                }

                return [...a, {id: idAttrib, storedAs: storedAsAttrib}];
            }, []);
        }
    }
}