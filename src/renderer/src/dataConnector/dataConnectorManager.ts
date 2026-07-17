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
import { DataConnectorPayload } from '@shared/types';
import { buildHostPage } from './hostPage';
import { DcToPlayerMessage } from './types';

// Stop a host only after this many consecutive ineligible assessments, so
// criteria TTL expiry or geo flapping doesn't restart connectors needlessly.
const STOP_AFTER_MISSED_TICKS = 3;

// Guardrails for connector setData calls.
const MIN_WRITE_INTERVAL = 500; // ms, per dataKey, keep-latest coalescing
const MAX_DATA_LENGTH = 2 * 1024 * 1024; // characters
const MAX_KEYS_PER_DATASET = 100;

interface ConnectorHost {
    connector: DataConnectorPayload;
    iframe: HTMLIFrameElement;
    // Restart detection: scheduleId|dataParams|md5 of the connector js file
    stateKey: string;
    missedTicks: number;
}

interface KeyWriteState {
    lastWriteAt: number;
    timer: ReturnType<typeof setTimeout> | null;
    queued: { host: ConnectorHost; data: string; requestId: number } | null;
    notifyPending: boolean;
    // Pending put for this dataKey — notify fan-out chains behind it so
    // widgets never read stale data after being notified.
    chain: Promise<void>;
}

/**
 * Hosts scheduled data connectors in hidden sandboxed iframes (in the renderer)
 * and bridges their `window.xiboDC` calls into the player.
 *
 * This is the Electron port of the ChromeOS player's DataConnectorManager. The
 * connector hosting, postMessage bridge, write coalescing and notification fan
 * out are identical; what differs is the storage/serving seam:
 *
 *  - ChromeOS stores realtime data in IndexedDB and serves it from a service
 *    worker. Electron has no service worker, so writes are forwarded to the main
 *    process over IPC (`window.apiHandler.realtimeSet`) into an in-memory store
 *    that the in-process Express server serves at `/realtime`.
 *  - The connector script is fetched from the local file server (`appHost`)
 *    rather than the service-worker cache. Its md5 integrity is verified in the
 *    main process before it is offered to the renderer, so there is no
 *    crypto/integrity step here.
 *  - Criteria set by a connector are relayed to main (where assessment runs)
 *    via `window.apiHandler.connectorCriteria`.
 *
 * The desired connector set is pushed from main (`update-data-connectors`);
 * this class diffs it against the running hosts on each `sync()`.
 */
export class DataConnectorManager {
    private hosts = new Map<number, ConnectorHost>();
    private container: HTMLDivElement | null = null;
    private isSyncing = false;

    private writeStates = new Map<string, KeyWriteState>();
    private keyOwners = new Map<string, number>(); // dataKey -> dataSetId
    private warnedKeys = new Set<string>();

    /**
     * @param appHost Base URL the local file server serves connector scripts
     *   from (the same value passed to XLR as `appHost`, e.g.
     *   `http://localhost:9696/files/`).
     */
    constructor(private readonly appHost: string) {
        window.addEventListener('message', (ev: MessageEvent) => {
            void this.onMessage(ev);
        });
    }

    /**
     * Reconcile the desired set of connectors (pushed from main) against the
     * running hosts. Called on every `update-data-connectors`.
     */
    async sync(connectors: DataConnectorPayload[]) {
        if (this.isSyncing) {
            return;
        }
        this.isSyncing = true;

        try {
            const desired = new Map<number, DataConnectorPayload>();
            for (const connector of connectors) {
                if (!Number.isNaN(connector.dataSetId)) {
                    desired.set(connector.dataSetId, connector);
                }
            }

            for (const [dataSetId, host] of Array.from(this.hosts)) {
                const want = desired.get(dataSetId);

                if (!want) {
                    // No longer eligible: apply stop hysteresis.
                    host.missedTicks++;
                    if (host.missedTicks >= STOP_AFTER_MISSED_TICKS) {
                        console.info('[DataConnectorManager] Data connector no longer scheduled, stopping', {
                            dataSetId,
                        });
                        await this.stopHost(dataSetId);
                    }
                    continue;
                }

                host.missedTicks = 0;

                // Restart when the event or the connector js file changed.
                const stateKey = this.getStateKey(want);
                if (stateKey !== host.stateKey) {
                    console.info('[DataConnectorManager] Data connector changed, restarting', {
                        dataSetId,
                    });
                    await this.stopHost(dataSetId);
                } else {
                    // Running and unchanged.
                    desired.delete(dataSetId);
                }
            }

            for (const connector of desired.values()) {
                await this.startHost(connector);
            }
        } finally {
            this.isSyncing = false;
        }
    }

    /**
     * The dataSetIds with a running host, for the status window.
     */
    getActiveDataSetIds() {
        return Array.from(this.hosts.keys());
    }

    private getStateKey(connector: DataConnectorPayload) {
        return connector.scheduleId + '|' + connector.dataParams + '|' + connector.md5;
    }

    private async startHost(connector: DataConnectorPayload) {
        const dataSetId = connector.dataSetId;

        // The connector js is served by the local file server at appHost. Its
        // integrity was verified in main before it was sent to us; here we only
        // fetch the source to inline into the sandboxed iframe.
        let connectorJs: string;
        try {
            const res = await fetch(this.appHost + connector.js);
            if (!res.ok) {
                // File not downloaded/served yet — retry on the next assessment.
                console.debug('[DataConnectorManager] Connector script not available yet, waiting', {
                    dataSetId,
                    js: connector.js,
                    status: res.status,
                });
                return;
            }
            connectorJs = await res.text();
        } catch (e) {
            console.debug('[DataConnectorManager] Failed to fetch connector script, will retry', {
                dataSetId,
                js: connector.js,
                error: (e as Error)?.message ?? String(e),
            });
            return;
        }

        const iframe = document.createElement('iframe');
        iframe.id = 'xibo-dc-' + dataSetId;
        iframe.setAttribute('sandbox', 'allow-scripts');
        iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
        iframe.srcdoc = buildHostPage(connectorJs);

        this.getContainer().appendChild(iframe);

        this.hosts.set(dataSetId, {
            connector,
            iframe,
            stateKey: this.getStateKey(connector),
            missedTicks: 0,
        });

        console.info('[DataConnectorManager] Data connector started', {
            dataSetId,
            scheduleId: connector.scheduleId,
        });
    }

    private async stopHost(dataSetId: number) {
        const host = this.hosts.get(dataSetId);

        if (!host) {
            return;
        }

        // Removing the iframe tears down the connector's timers and requests.
        host.iframe.remove();
        this.hosts.delete(dataSetId);

        // Find the keys this connector owned (tracked locally), clear them in
        // the main store, and let widgets know so they re-fetch and degrade
        // gracefully on the resulting 404.
        const dataKeys: string[] = [];
        for (const [dataKey, owner] of Array.from(this.keyOwners)) {
            if (owner === dataSetId) {
                dataKeys.push(dataKey);
            }
        }

        try {
            await window.apiHandler.realtimeClear(dataSetId);
        } catch (e) {
            console.error('[DataConnectorManager] Failed to clear realtime data', {
                dataSetId,
                error: (e as Error)?.message ?? String(e),
            });
        }

        for (const dataKey of dataKeys) {
            const writeState = this.writeStates.get(dataKey);
            if (writeState?.timer) {
                clearTimeout(writeState.timer);
            }
            this.writeStates.delete(dataKey);
            this.keyOwners.delete(dataKey);
            this.notifyWidgets(dataKey);
        }

        console.info('[DataConnectorManager] Data connector stopped', { dataSetId });
    }

    /**
     * Notify all rendered widget iframes that data behind a key has changed.
     * XLR media iframes have deterministic ids (M-<id>-<n>-iframe); xiboIC
     * inside each widget turns this message into its notify data callback.
     */
    notifyWidgets(dataKey: string) {
        document
            .querySelectorAll<HTMLIFrameElement>('iframe[id^="M-"][id$="-iframe"]')
            .forEach((el) => {
                console._log('[DataConnectorManager] Notifying widget iframe of data change', {
                    dataKey,
                    iframeId: el.id,
                    el,
                });
                el.contentWindow?.postMessage({ ctrl: 'rtNotifyData', data: { dataKey } }, '*');
            });
    }

    private getContainer() {
        if (!this.container) {
            this.container = document.createElement('div');
            this.container.id = 'xibo-dc-container';
            document.body.appendChild(this.container);
        }

        return this.container;
    }

    private findHost(source: MessageEventSource | null) {
        for (const host of this.hosts.values()) {
            if (host.iframe.contentWindow === source) {
                return host;
            }
        }

        return undefined;
    }

    private async onMessage(ev: MessageEvent) {
        const msg = ev.data as DcToPlayerMessage;

        if (!msg || msg.from !== 'xiboDC') {
            return;
        }

        const host = this.findHost(ev.source);
        if (!host) {
            return;
        }

        const dataSetId = host.connector.dataSetId;

        switch (msg.type) {
            case 'loaded':
                host.iframe.contentWindow?.postMessage({
                    type: 'init',
                    id: dataSetId,
                    // The CMS urlencode()s dataSetParams ('+' for spaces).
                    params: { data: decodeURIComponent(host.connector.dataParams.replace(/\+/g, ' ')) },
                }, '*');
                break;

            case 'set':
                this.handleSet(host, msg.dataKey, String(msg.data ?? ''), msg.requestId);
                break;

            case 'notify':
                this.handleNotify(msg.dataKey);
                break;

            case 'criteria':
                if (msg.data && msg.data.metric && msg.data.value !== null && msg.data.value !== undefined) {
                    void window.apiHandler.connectorCriteria(msg.data.metric, msg.data.value, msg.data.ttl);
                }
                break;

            case 'request':
                await this.handleRequest(host, msg.requestId, msg.path, msg.options);
                break;

            case 'log':
                console.debug('[DataConnector ' + dataSetId + ']', ...(msg.data ?? []));
                break;

            case 'error':
                console.error('[DataConnector ' + dataSetId + '] ' + msg.message, {
                    line: msg.line,
                });
                break;
        }
    }

    private getWriteState(dataKey: string) {
        let writeState = this.writeStates.get(dataKey);

        if (!writeState) {
            writeState = {
                lastWriteAt: 0,
                timer: null,
                queued: null,
                notifyPending: false,
                chain: Promise.resolve(),
            };
            this.writeStates.set(dataKey, writeState);
        }

        return writeState;
    }

    private handleSet(host: ConnectorHost, dataKey: string, data: string, requestId: number) {
        const dataSetId = host.connector.dataSetId;

        if (!dataKey) {
            this.respond(host, requestId, false, 400, 'A dataKey is required');
            return;
        }

        if (data.length > MAX_DATA_LENGTH) {
            this.warnOnce(dataKey + ':size', 'Data connector ' + dataSetId
                + ' exceeded the maximum data size for key ' + dataKey);
            this.respond(host, requestId, false, 413, 'Data too large');
            return;
        }

        // Detect distinct connectors fighting over the same key (last write wins).
        const owner = this.keyOwners.get(dataKey);
        if (owner !== undefined && owner !== dataSetId) {
            this.warnOnce(dataKey + ':owner', 'Data key ' + dataKey
                + ' is written by multiple data connectors (' + owner + ', ' + dataSetId + ')');
        }
        this.keyOwners.set(dataKey, dataSetId);

        if (owner === undefined
            && this.countKeysOwnedBy(dataSetId) > MAX_KEYS_PER_DATASET) {
            this.keyOwners.delete(dataKey);
            this.warnOnce(String(dataSetId) + ':keys', 'Data connector ' + dataSetId
                + ' exceeded the maximum number of data keys');
            this.respond(host, requestId, false, 429, 'Too many data keys');
            return;
        }

        const writeState = this.getWriteState(dataKey);
        const now = Date.now();

        if (writeState.timer === null && now - writeState.lastWriteAt >= MIN_WRITE_INTERVAL) {
            this.write(host, dataKey, data, requestId, writeState);
        } else {
            // Coalesce: keep the latest value, complete the superseded call.
            if (writeState.queued) {
                this.respond(writeState.queued.host, writeState.queued.requestId, true, 200, '');
            }
            writeState.queued = { host, data, requestId };

            if (writeState.timer === null) {
                const delay = Math.max(0, MIN_WRITE_INTERVAL - (now - writeState.lastWriteAt));
                writeState.timer = setTimeout(() => {
                    writeState.timer = null;
                    const queued = writeState.queued;
                    writeState.queued = null;

                    if (queued) {
                        this.write(queued.host, dataKey, queued.data, queued.requestId, writeState);

                        if (writeState.notifyPending) {
                            writeState.notifyPending = false;
                            this.handleNotify(dataKey);
                        }
                    }
                }, delay);
            }
        }
    }

    private write(
        host: ConnectorHost,
        dataKey: string,
        data: string,
        requestId: number,
        writeState: KeyWriteState,
    ) {
        const dataSetId = host.connector.dataSetId;

        writeState.lastWriteAt = Date.now();
        writeState.chain = writeState.chain
            .then(() => {
                return window.apiHandler.realtimeSet(dataKey, dataSetId, data);
            })
            .then((result) => {
                this.respond(host, requestId, result.success, result.status, '');
            })
            .catch((e) => {
                console.error('[DataConnectorManager] Failed to store realtime data', {
                    dataKey,
                    dataSetId,
                    error: e?.message ?? String(e),
                });
                this.respond(host, requestId, false, 500, 'Failed to store data');
            });
    }

    private handleNotify(dataKey: string) {
        const writeState = this.writeStates.get(dataKey);

        if (!writeState) {
            // No data written through this manager; notify regardless.
            this.notifyWidgets(dataKey);
            return;
        }

        if (writeState.queued) {
            // A coalesced write is pending: notify once it has flushed.
            writeState.notifyPending = true;
            return;
        }

        // Fan out only after the pending put resolves so widgets read fresh data.
        void writeState.chain.then(() => {
            this.notifyWidgets(dataKey);
        });
    }

    private async handleRequest(
        host: ConnectorHost,
        requestId: number,
        path: string,
        options: { type?: string; headers?: { key: string; value: string }[]; data?: any } = {},
    ) {
        const method = options.type || 'GET';

        const headers: Record<string, string> = {};
        (options.headers ?? []).forEach((header) => {
            headers[header.key] = header.value;
        });

        let data: string | undefined = undefined;
        if (options.data !== undefined && method !== 'GET' && method !== 'HEAD') {
            data = typeof options.data === 'string' ? options.data : JSON.stringify(options.data);

            if (!headers['Content-Type']) {
                headers['Content-Type'] = 'application/json;charset=UTF-8';
            }
        }

        try {
            const res = await window.apiHandler.connectorRequest(path, { method, headers, data });
            this.respond(host, requestId, res.ok, res.status, res.body);
        } catch (e: any) {
            this.respond(host, requestId, false, 0, e?.message ?? String(e));
        }
    }

    private respond(host: ConnectorHost, requestId: number, success: boolean, status: number, data: string) {
        host.iframe.contentWindow?.postMessage({
            type: 'response',
            requestId,
            success,
            status,
            data,
        }, '*');
    }

    private countKeysOwnedBy(dataSetId: number) {
        let count = 0;
        for (const owner of this.keyOwners.values()) {
            if (owner === dataSetId) {
                count++;
            }
        }

        return count;
    }

    private warnOnce(key: string, message: string) {
        if (this.warnedKeys.has(key)) {
            return;
        }
        this.warnedKeys.add(key);

        console.error(message);
    }
}
