import Dexie from "dexie";
import FaultsDB from "./faultsDB";
import LogsDB from "./logsDB";
import FaultsLib from "../faultsLib";
import LoggerLib from "../loggerLib";

export const PlayerDBName = 'PlayerDB';

export default class PlayerDB extends Dexie {
    private readonly dbVersion: number = 1;
    logLevel: string = 'error';
    logs!: Dexie.Table<LogsDB, string>;
    faults!: Dexie.Table<FaultsDB, number>;
    logsLib!: LoggerLib;
    faultsLib!: FaultsLib;

    constructor() {
        super(PlayerDBName);

        this.version(this.dbVersion).stores({
            faults: '&code, date, expires',
            logs: 'uid, date, category, timestamp',
            stats: '++id, type, fromdt, todt, scheduleid, layoutid, mediaid, timestamp, duration',
        });

        this.logsLib = new LoggerLib();
        this.faultsLib = new FaultsLib();

        this.logs.mapToClass(LogsDB);
        this.faults.mapToClass(FaultsDB);

        this.logsLib.table = this.logs;
        this.faultsLib.table = this.faults
    }

    setLogLevel(logLevel: string) {
        this.logLevel = logLevel;
        this.logsLib.setLogLevel(this.logLevel);
    }
}

export const db = new PlayerDB();
