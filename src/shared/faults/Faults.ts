import { createNanoEvents, Emitter } from "nanoevents";
import { DateTime } from "luxon";
import { ConsoleDB, LogEntry } from "../console/ConsoleDB";
import { setExpiry } from "../../main/common/parser";

export enum FaultCodes {
    FaultNotLicensed = 1000,
    FaultMemoryRunningLow = 1001,
    FaultMemoryCritical = 1002,
    FaultPowerPointNotAvailable = 1003,
    FaultGeneralError = 1004,

    FaultVideoSource = 2001,
    FaultVideoUnexpected = 2099,

    FaultImageUnknown = 3000,
    FaultImageDecode = 3001,
    FaultImageOutOfMemory = 3002,

    FaultXMRUnknownCommand = 4000,
    FaultFileAddFailed = 4400,
    FaultFileDeleteFailed = 4401,
    FaultRemoteResourceFailed = 4404,

    FaultXlfNoContent = 5000,
    FaultBadResponse = 5003,
    FaultBadRequest = 5002,
    FaultNoData = 5001,
    FaultGlobalDependenciesMissing = 5004,

    FaultSettingNotAvailable = 6000,
    FaultTimerInvalidDay = 6001,
    FaultTimerInvalidTime = 6002,
    FaultPicturePropertySetFailed = 6003,
    FaultPicturePropertyInvalidValue = 6004,
    FaultPicturePropertyValueOutOfRange = 6005,
}

export interface FaultsEvents {
    message: (eventData: any) => void;
}

export interface FaultLogEntry extends LogEntry {}

export class Faults {
    private db: ConsoleDB;

    emitter: Emitter<FaultsEvents> = createNanoEvents<FaultsEvents>();
    clearIntervalId: NodeJS.Timeout | null = null;

    // Cached result of getActiveFaults(). null means the cache needs rebuilding.
    // Invalidated whenever faults are raised or removed; rebuilt lazily on next read.
    private _activeFaultsCache: ReturnType<Faults['getActiveFaults']> | null = null;

    private _invalidateCache() {
        this._activeFaultsCache = null;
    }

    constructor(db: ConsoleDB) {
        this.db = db;

        this.on('message', data => {
            const faultEntry: Partial<FaultLogEntry> = {
                message: data?.reason || null,
                code: String(parseInt(data?.code || FaultCodes.FaultGeneralError.toString())),
                mediaId: data?.mediaId || null,
                regionId: data?.regionId || null,
                widgetId: data?.widgetId || null,
                layoutId: data?.layoutId || null,
                scheduleId: data?.scheduleId || null,
                date: data?.date || DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss'),
                expires: data?.expires || setExpiry({days: 1}),
            }

            if (this.db.faultExists(String(faultEntry.code ?? FaultCodes.FaultGeneralError), {
                layoutId: faultEntry.layoutId,
                regionId: faultEntry.regionId,
                widgetId: faultEntry.widgetId,
                mediaId: faultEntry.mediaId,
                scheduleId: faultEntry.scheduleId,
            })) {
                return;
            }

            console.debug('[Faults::on("message")] > New fault reported', {
                faultEntry,
            });
            console.fault(faultEntry.message, {
                ...faultEntry,
                shouldParse: false,
            });

            this._invalidateCache();
        });
    }

    on<E extends keyof FaultsEvents>(event: E, callback: FaultsEvents[E]) {
        return this.emitter.on(event, callback);
    }

    /**
     * Clears all faults from database
     * @param caller Identifier for where the function call originates
     */
    clearDB(caller?: string) {
        console.debug(`[Faults::clearDB] - Clearing faults from database. Caller: ${caller}`);
        try {
            this.db.deleteLogsByCategory('Fault');
            this._invalidateCache();
        } catch (err) {
            console.warn(`[Faults::clearDB] - Failed to clear faults DB (caller: ${caller})`, err);
        }
    }

    /**
     * Clear faults
     * @param interval Interval in seconds
     */
    clear(interval = 10) {
        if (this.clearIntervalId !== null) {
            clearInterval(this.clearIntervalId);
        }

        this.clearIntervalId = setInterval(async () => {
            this.clearExpired();
        }, interval * 1000);

        this.clearExpired();
    }

    /**
     * Clear expired faults
     * @param interval Interval in seconds
     */
    clearExpired() {
        try {
            this.db.deleteExpiredByCategory('Fault');
            this._invalidateCache();
        } catch (err) {
            console.warn('[Faults::clearExpired] - Failed to delete expired faults', err);
        }
    }

    /**
     * Returns all non-expired faults from the database.
     * @returns Active faults with their code and reason
     */
    getActiveFaults(): Array<{code: number, reason: string, layoutId: number | null, scheduleId: number | null, mediaId: number | null}> {
        if (this._activeFaultsCache === null) {
            const faults = this.db.getLogsByCategory('Fault');
            this._activeFaultsCache = faults
                .filter(f => f.message !== null && String(f.message).trim() !== '')
                .map(f => ({
                    code: parseInt(f.code ?? FaultCodes.FaultGeneralError.toString()),
                    reason: f.message ?? '',
                    mediaId: f.mediaId ?? null,
                    layoutId: f.layoutId ?? null,
                    scheduleId: f.scheduleId ?? null,
                }));
        }
        return this._activeFaultsCache;
    }

    toJson() {
        const faults = this.db.getLogsByCategory('Fault');

        // Compose fault for XMDS submission
        const faultData = faults.reduce((faults, fault) => {
            if (fault.message === null || String(fault.message).trim() === '') {
                return faults;
            }

            const faultItem = {
                key: fault.code || FaultCodes.FaultGeneralError,
                code: parseInt(fault.code ?? FaultCodes.FaultGeneralError.toString()),
                reason: fault.message,
                mediaId: fault.mediaId ?? null,
                regionId: fault.regionId ?? null,
                widgetId: fault.widgetId ?? null,
                layoutId: fault.layoutId ?? null,
                scheduleId: fault.scheduleId ?? null,
                expires: fault.expires ?? null,
            };

            return [...faults, faultItem];
        }, [] as any[]);

        return JSON.stringify(faultData);
    }
}
