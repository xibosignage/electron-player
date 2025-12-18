import { DateTime } from "luxon";
import { createNanoEvents, Emitter } from "nanoevents";

import { handleError } from "../../xmds/error/error";
import { StatEntry, StatsDB } from "./StatsDB";

export enum StatsAggregationType {
    INDIVIDUAL = 'Individual',
    HOURLY = 'Hourly',
    DAILY = 'Daily',
}

export type StatsOptions = {
    aggregated?: boolean;
    aggregation?: StatsAggregationType;
}

export interface PoPStatsEvents {
    message: (eventData: any) => void;
}

export class PoPStats {
    readonly options?: StatsOptions = <StatsOptions>{};
    private db: StatsDB;

    emitter: Emitter<PoPStatsEvents> = createNanoEvents<PoPStatsEvents>();

    constructor(_options: StatsOptions = {}) {
        this.options = _options;
        this.db = new StatsDB();

        // Clear the stats DB on each start
        this.clearDB();

        this.on('message', data => {
            const eventData = data;
            let params: any = {};

            params.scheduleid = eventData?.scheduleId || -1;
            params.type = eventData?.type || 'layout';
            params.mediaid = eventData?.mediaId || null;
            params.layoutid = eventData?.layoutId || -1;
            params.timestamp = DateTime.now().toMillis();

            if (eventData?.action) {
                switch (eventData.action) {
                    case 'START_STAT':
                        const startStat = {
                            ...params,
                            duration: 0,
                            fromdt: DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss'),
                            todt: '',
                            count: 1,
                        }
                        console.debug('[PoPStats::statsBC] START_STAT', startStat);
                        this.addStat(startStat);
                        break;
                    case 'END_STAT':
                        const endStat = {
                            ...params,
                            todt: DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss'),
                        };
                        console.debug('[PoPStats::statsBC] END_STAT', endStat);
                        this.updateStat(endStat);
                        break;
                    default:
                        break;
                }
            }
        });
    }

    on<E extends keyof PoPStatsEvents>(event: E, callback: PoPStatsEvents[E]) {
        return this.emitter.on(event, callback);
    }

    clearDB() {
        this.db.deleteAll();
    }

    addStat(stat: StatEntry) {
        try {
            this.db.insert(stat);
            return stat;
        } catch (e) {
            return handleError(e);
        }
    }

    updateStat(stat: Partial<StatEntry>, ) {
        try {
            let getStat;
            let query: any = {};

            if (stat.layoutid) {
                query.layoutid = stat.layoutid;
            }

            if (stat.scheduleid) {
                query.scheduleid = stat.scheduleid;
            }

            if (stat.mediaid) {
                query.mediaid = stat.mediaid;
            }

            if (stat.type) {
                query.type = stat.type;
            }

            // Only update record with zero duration
            query.duration = 0;

            getStat = this.db.get(query);

            if (getStat) {
                const fromDt = DateTime.fromFormat(getStat.fromdt as string, 'yyyy-MM-dd HH:mm:ss').toMillis();
                const toDt = DateTime.fromFormat(stat.todt as string, 'yyyy-MM-dd HH:mm:ss');
                const toDtInMs = toDt.toMillis();

                let duration = 0;

                if (toDtInMs > fromDt) {
                    duration = toDtInMs - fromDt;
                }

                // Update stat
                return this.db.update(getStat.id, {
                    todt: stat.todt,
                    duration: duration / 1000,
                });
            }

            return false;
        } catch (e) {
            return handleError(e);
        }
    }

    getStats(size = 0) {
        return this.db.getAll(size);
    }

    clearSubmitted(stats: Array<StatEntry>) {
        const statIDs = stats.map(stat => stat.id) as number[];
        this.db.bulkDeleteByIds(statIDs);
    }

}
