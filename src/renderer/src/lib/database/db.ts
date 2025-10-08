import Dexie, { type EntityTable } from "dexie";
import FaultsDB from "./faultsDB";

export default class PlayerDB extends Dexie {
    private readonly dbVersion: number = 1;
    faults!: EntityTable<FaultsDB, 'code'>;

    constructor() {
        super('PlayerDB');

        this.version(this.dbVersion).stores({
            faults: '&code, date, expires',
            logs: 'uid, date, category, timestamp',
            requiredFiles: '&shortPath, saveAs, date',
            stats: '++id, type, fromdt, todt, scheduleid, layoutid, mediaid, timestamp, duration',
        });

        this.faults.mapToClass(FaultsDB);
    }
}

// export const db = new PlayerDB();
export const db = { faults: { clear() {} } };
