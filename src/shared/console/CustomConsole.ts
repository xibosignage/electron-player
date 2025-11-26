import { Console } from "console";
import { ConsoleDB } from "./ConsoleDB";

export type ConsoleLevel = 'log'
 | 'info'
 | 'debug'
 | 'warn'
 | 'error'
 | 'alert'
 | 'fault';

export class Logger {
    constructor(private context: 'main' | 'renderer', private db?: ConsoleDB) {

    }

    async logToDB(baseLogger: Console, level: ConsoleLevel, ...args: unknown[]) {
        const consoleLevelMap = {
            log: 'log',
            info: 'info',
            debug: 'debug',
            warn: 'warn',
            error: 'error',
            alert: 'warn',
            fault: 'error',
            _log: 'log',
        };
        (baseLogger[consoleLevelMap[level]])(`[${level}]`, ...args);
    }
}

export class CustomConsole extends Console {
    private baseConsole: Console = globalThis.console;

    constructor(private logger: Logger) {
        super(process.stdout, process.stderr);
    }

    log(...data: unknown[]) {
        this.baseConsole.log.apply(this.baseConsole, data);
        this.logger.logToDB(this.baseConsole, 'log', ...data);
    }

    debug(...data: unknown[]) {
        this.baseConsole.debug.apply(this.baseConsole, data);
        this.logger.logToDB(this.baseConsole, 'debug', ...data);
    }

    alert(...data: unknown[]) {
        this.baseConsole.warn.apply(this.baseConsole, data);
        this.logger.logToDB(this.baseConsole, 'alert', ...data);
    }

    _log(...data: unknown[]) {
        this.baseConsole.log.apply(this.baseConsole, data);
        this.logger.logToDB(this.baseConsole, 'log', ...data);
    }
}