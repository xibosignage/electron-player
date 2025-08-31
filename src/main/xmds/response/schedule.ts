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

export default class Schedule {
    private readonly response: string;
    schedule: any;

    constructor(response: string) {
        this.response = response;
        this.schedule = {};
    }

    async parse() {
        const parser = new xml2js.Parser();
        const rootDoc = await parser.parseStringPromise(this.response);

        // Get the encoded XML
        const xml = rootDoc["SOAP-ENV:Envelope"]["SOAP-ENV:Body"][0]["ns1:ScheduleResponse"][0].ScheduleXml[0]._;

        // Parse out attributes.
        this.schedule = await parser.parseStringPromise(xml);
        
        // TODO: decide how XMDS should return the schedule (imagine it is part of XCL)
        // is a JS object sufficient?
    }
}