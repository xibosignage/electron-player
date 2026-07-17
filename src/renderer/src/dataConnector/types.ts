/*
 * Copyright (c) 2025 Xibo Signage Ltd
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
 * postMessage protocol between a data connector host iframe and the player.
 *
 * Message shapes for `set`, `notify`, `criteria`, `log` and `loaded` match the
 * CMS data connector test harness (views/dataset-data-connector-test-page.twig)
 * so a connector validated in the CMS behaves identically on the player.
 * The player additions are: a `from: 'xiboDC'` tag on every outbound message,
 * `requestId` correlation for `set`/`request`, and the `request`/`error` types.
 *
 * Kept in sync with the ChromeOS player's equivalent so connectors are portable.
 */

export type DcRequestOptions = {
    type?: string;
    headers?: { key: string; value: string }[];
    data?: any;
};

export type DcToPlayerMessage =
    | { from: 'xiboDC'; type: 'loaded' }
    | { from: 'xiboDC'; type: 'set'; requestId: number; dataKey: string; data: string }
    | { from: 'xiboDC'; type: 'notify'; dataKey: string }
    | {
        from: 'xiboDC';
        type: 'criteria';
        dataKey: string;
        data: { metric: string; value: any; ttl: number };
      }
    | {
        from: 'xiboDC';
        type: 'request';
        requestId: number;
        path: string;
        options: DcRequestOptions;
      }
    | { from: 'xiboDC'; type: 'log'; data: any[] }
    | { from: 'xiboDC'; type: 'error'; message: string; line?: number };

export type PlayerToDcMessage =
    | { type: 'init'; id: number; params: { data: string } }
    | {
        type: 'response';
        requestId: number;
        success: boolean;
        status: number;
        data: string;
      };
