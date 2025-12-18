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
import { Layout, LayoutResponseType } from './events/layout';
import { DefaultLayout } from './events/defaultLayout';
import { OverlayLayout, OverlayLayoutResponseType } from './events/overlayLayout';
import { Action, ActionResponseType } from './events/action';
import { DataConnector, DataConnectorResponseType } from './events/dataConnector';
import { getLayoutFile } from '../../../common/fileManager';

export type DependantsFileType = {
    file: string[];
}

export type CommandType = {
    code: string | null;
    date: string;
}

export interface ScheduleInterface {
    filterFrom: string | undefined;
    filterTo: string | undefined;
    generated: string | undefined;
    dependants: string[];
    defaultLayout: DefaultLayout | undefined;
    layouts: Layout[];
    overlays: OverlayLayout[];
    actions: Action[];
    dataConnectors: DataConnector[];
    command?: CommandType | undefined;

    parse(): Promise<void>;
    countLayouts(): number;
}

export default class Schedule implements ScheduleInterface {
    private readonly response: string;
    filterFrom: string | undefined;
    filterTo: string | undefined;
    generated: string | undefined;
    dependants: string[] = [];
    defaultLayout: DefaultLayout = <DefaultLayout>{};
    layouts: Layout[] = [];
    overlays: OverlayLayout[] = [];
    actions: Action[] = [];
    dataConnectors: DataConnector[] = [];
    command?: CommandType | undefined;

    constructor(response: string) {
        this.response = response;
    }

    async parse(): Promise<void> {
        const parser = new xml2js.Parser();
        const rootDoc = await parser.parseStringPromise(this.response);

        // Get the encoded XML
        const xml = rootDoc["SOAP-ENV:Envelope"]["SOAP-ENV:Body"][0]["ns1:ScheduleResponse"][0].ScheduleXml[0]._;

        const doc = await parser.parseStringPromise(xml);

        // Parse out attributes.
        this.filterFrom = doc.schedule.$.filterFrom ?? '';
        this.filterTo = doc.schedule.$.filterTo ?? '';
        this.generated = doc.schedule.$.generated ?? '';

        this.defaultLayout = new DefaultLayout();
        this.defaultLayout.hydrateFromResponse(doc.schedule.default[0]);
        const defaultLayoutFile = getLayoutFile(this.defaultLayout.file);

        if (defaultLayoutFile) {
            this.defaultLayout.path = defaultLayoutFile.name;
        }

        // TODO: decide how XMDS should return the schedule (imagine it is part of XCL)
        // is a JS object sufficient?

        // Parse layouts
        if (doc.schedule && doc.schedule.layout &&
            doc.schedule.layout.length > 0
        ) {
            this.layouts = doc.schedule.layout.reduce((a: Layout[], b: LayoutResponseType) => {
                return [...a, new Layout(b)];
            }, []);
        }

        // Parse dependants
        if (doc.schedule && doc.schedule.dependants &&
            doc.schedule.dependants.length > 0
        ) {
            this.dependants = doc.schedule.dependants.reduce((a: string[], b: DependantsFileType) => {
                return [...a, ...b.file];
            }, []);
        }

        // Parse overlay layouts
        if (doc.schedule && doc.schedule.overlays &&
            doc.schedule.overlays.length === 1 &&
            doc.schedule.overlays[0].overlay
        ) {
            this.overlays = doc.schedule.overlays[0].overlay.reduce((a: OverlayLayout[], b: OverlayLayoutResponseType) => {
                return [...a, new OverlayLayout(b)];
            }, []);
        }

        // Parse actions
        if (doc.schedule && doc.schedule.actions &&
            doc.schedule.actions.length === 1 &&
            doc.schedule.actions[0].action
        ) {
            this.actions = doc.schedule.actions[0].action.reduce((a: Action[], b: ActionResponseType) => {
                return [...a, new Action(b)];
            }, []);
        }

        // Parse dataConnectors
        if (doc.schedule && doc.schedule.dataConnectors &&
            doc.schedule.dataConnectors.length === 1 &&
            doc.schedule.dataConnectors[0].connector
        ) {
            this.dataConnectors = doc.schedule.dataConnectors[0].connector.reduce((a: DataConnector[], b: DataConnectorResponseType) => {
                return [...a, new DataConnector(b)];
            }, []);
        }

        // Parse command
        if (doc.schedule && doc.schedule.command &&
            doc.schedule.command.length === 1
        ) {
            this.command = <CommandType>{
                code: doc.schedule.command[0].$.command,
                date: doc.schedule.command[0].$.date,
            };
        }
    }

    countLayouts(): number {
        return this.layouts.length;
    }
}