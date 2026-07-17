import { v4 as uuidv4 } from 'uuid';
import he from 'he';

import type { ConsoleDB, LogEntry } from './ConsoleDB';
import { flatLogObj, FlattenedObject, flattenObject, unflattenObject } from '../../main/common/parser';
import { LogCategoryType } from '../loggerLib';

export interface ConfigAdapter {
  getConfig(): Promise<any> | any;
}

let adapter: ConfigAdapter | null = null;

export function registerConfigAdapter(configAdapter: ConfigAdapter) {
  adapter = configAdapter;
}

export async function loadConfig() {
  try {
    if (adapter !== null) {
      return await adapter.getConfig();
    }
  } catch (err) {
    throw new Error('Config adapter not registered');
  }
}

export type ConsoleLevel =
  | 'log'
  | 'info'
  | 'debug'
  | 'warn'
  | 'error'
  | 'alert'
  | 'fault';

export interface ExtendedConsole extends Console {
  alert: (...data: any[]) => void;
  fault: (...data: any[]) => void;
  _log: (...data: any[]) => void;
}

export const levelsCategoryMap: Record<ConsoleLevel, LogCategoryType> = {
  log: 'Audit',
  debug: 'Audit',
  info: 'Debug',
  error: 'Error',
  warn: 'Error',
  alert: 'event',
  fault: 'Fault',
}

export function createExtendedConsole(
  opts: {
    db?: ConsoleDB;
    context: 'main' | 'renderer';
    sendToMain?: (level: ConsoleLevel, ...args: any[]) => void;
    getLogLevel?: () => string;
  }
): ExtendedConsole {
  const { db, context = 'main', sendToMain } = opts;
  const base = globalThis.console;

  const logToDB = (level: ConsoleLevel, ...data: any[]) => {
    const logLevel = opts.getLogLevel ? opts.getLogLevel() : 'error';

    // When logging is completely disabled, stop here
    if (logLevel === 'off') {
      return;
    }

    // Determine whether this log should be written to the DB based on logLevel
    const shouldWriteToDB =
      !(['debug', 'info', 'log'].includes(level) && logLevel === 'error');

    if (db && shouldWriteToDB) {
      let logEntry = getLogEntryFromArgs(undefined, data) as LogEntry | undefined;

      // Try to serialize data
      if (!logEntry) {
        logEntry = serializeArgs(data.flat(), level) as LogEntry;
      }

      if (logEntry && isLogEntry(logEntry)) {
        logEntry.level = level;
        logEntry.context = context;
      }

      if (logEntry) {
        // Escape message to prevent issues with special characters
        let logMsg = logEntry.message;

        if (level !== 'fault') {
          logMsg = "<![CDATA[" + logEntry.message + "]]>"
        }

        logEntry.message = he.encode(logMsg);
        logEntry.category = levelsCategoryMap[level] as LogCategoryType;

        if (level === 'fault' && db.faultExists(logEntry.code ?? null, {
          layoutId: logEntry.layoutId ?? null,
          regionId: logEntry.regionId ?? null,
          widgetId: logEntry.widgetId ?? null,
          mediaId: logEntry.mediaId ?? null,
          scheduleId: logEntry.scheduleId ?? null,
        })) {
          return;
        }

        try {
          db.insert(logEntry);
        } catch (err) {
          base.error(`[ExtendedConsole::${context}] Failed to write log to DB`, { error: err, logEntry });
        }
      }
    }

    // Always forward to main — the main process applies its own logLevel filter
    // before writing to DB. Without this, renderer logs are silently dropped when
    // the renderer context has no db of its own.
    if (sendToMain) {
      sendToMain(level, ...data);
    }
  }

  const isLogEntry = (obj: any): obj is LogEntry => {
    return typeof obj === 'object' &&
      obj !== null &&
      'uid' in obj &&
      typeof obj.uid === 'string';
  }
  const getLogEntryFromArgs = (logIndex: number | undefined, data?: any[]) => {
    let _logIndex = logIndex;
    const args = data ? data.flat() : [];

    if (!_logIndex && args.length > 0) {
      _logIndex = args.findIndex((a: any) => isLogEntry(a));
    }

    let logEntry: any;
    if (_logIndex && _logIndex !== -1) {
      logEntry = args[_logIndex];
    }

    return logEntry;
  }

  const wrap = (level: ConsoleLevel, nativeFn: (...args: any[]) => void) =>
    (...args: any[]) => {
      const logEntryIndex = args.findIndex(l => isLogEntry(l));
      let computedArgs: any[] = [];

      let logEntry: any;
      if (logEntryIndex !== -1) {
        args.forEach((arg, argIndex) => {
          if (argIndex === logEntryIndex) {
            logEntry = args[logEntryIndex];
            computedArgs = [...computedArgs, ...Object.values(unflattenObject(logEntry.log as FlattenedObject))];
          } else {
            computedArgs = [...computedArgs, arg];
          }
        })
      } else {
        computedArgs = args;
      }

      if (computedArgs) {
        nativeFn(...computedArgs);
      }

      logToDB(level, args);
    }

  const extended: ExtendedConsole = {
    ...base,
    log: wrap('log', (...args) => base.log.apply(base, args)),
    info: wrap('info', (...args) => base.info.apply(base, args)),
    debug: wrap('debug', (...args) => base.debug.apply(base, args)),
    warn: wrap('warn', (...args) => base.warn.apply(base, args)),
    error: wrap('error', (...args) => base.error.apply(base, args)),
    alert: wrap('alert', (...args) => base.warn('[ALERT]', ...args)),
    fault: wrap('fault', (...args) => base.error('[FAULT]', ...args)),
    _log: base.log.bind(base),
  };

  return extended;
}

export function serializeArgs(input: any[], level: ConsoleLevel): LogEntry {
  const log: LogEntry = {
    uid: uuidv4(),
    level: level ?? 'log',
    message: '',
    timestamp: Date.now(),
    context: 'main',
    method: undefined,
    scheduleId: undefined,
    layoutId: undefined,
    mediaId: undefined,
    category: 'Error',
    eventType: undefined,
    alertType: undefined,
    refId: undefined,
    log: {} as Record<string, any>,
    code: undefined,
    count: undefined,
    date: undefined,
    expires: undefined,
    regionId: undefined,
    widgetId: undefined,
  };

  let consoleDataObj: LogEntry | undefined = undefined;

  // Parse consoleData and check for possible submitLogs params
  if (input.length > 1) {
    if (typeof input[1] === 'object' && input[1] !== null) {
      consoleDataObj = input[1];
    }
  }

  if (consoleDataObj && Boolean(consoleDataObj['scheduleId'])) {
    log.scheduleId = consoleDataObj['scheduleId'];
  }

  if (consoleDataObj && Boolean(consoleDataObj['layoutId'])) {
    log.layoutId = consoleDataObj['layoutId'];
  }

  if (consoleDataObj && Boolean(consoleDataObj['mediaId'])) {
    log.mediaId = consoleDataObj['mediaId'];
  }

  if (consoleDataObj && Boolean(consoleDataObj['method'])) {
    log.method = consoleDataObj['method'];
  }

  // Check for log alert props
  if (consoleDataObj && Boolean(consoleDataObj['eventType'])) {
    log.eventType = consoleDataObj['eventType'];
  }

  if (consoleDataObj && Boolean(consoleDataObj['alertType'])) {
    log.alertType = consoleDataObj['alertType'];
  }

  if (consoleDataObj && Boolean(consoleDataObj['refId'])) {
    log.refId = consoleDataObj['refId'];
  }

  if (consoleDataObj && Boolean(consoleDataObj['code'])) {
    log.code = String(parseInt(String(consoleDataObj['code'])));
  }

  if (consoleDataObj && Boolean(consoleDataObj['count'])) {
    log.count = consoleDataObj['count'];
  }

  if (consoleDataObj && Boolean(consoleDataObj['date'])) {
    log.date = consoleDataObj['date'];
  }

  if (consoleDataObj && Boolean(consoleDataObj['expires'])) {
    log.expires = consoleDataObj['expires'];
  }

  if (consoleDataObj && Boolean(consoleDataObj['regionId'])) {
    log.regionId = consoleDataObj['regionId'];
  }

  if (consoleDataObj && Boolean(consoleDataObj['widgetId'])) {
    log.widgetId = consoleDataObj['widgetId'];
  }

  const flat = flattenObject(input);
  const unflattenMsg = flatLogObj(Object.values(unflattenObject(flat)));

  log.message = unflattenMsg;
  log.log = flat;

  return log;
}