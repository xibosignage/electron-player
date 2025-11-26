import { DateTime, DurationLike } from "luxon";

import { MediaInventoryFileType } from "./types";
import { ScheduleLayoutsType } from "./scheduleManager";
import { LogEntry } from "../../shared/console/ConsoleDB";
import { StatEntry } from "./stats/StatsDB";

export function getLayoutIds(layouts: ScheduleLayoutsType[]): number[] {
    return layouts.reduce((a: number[], b) => {
        return [...a, b.file];
    }, []);
}

export function mediaInventoryFileXmlString(fileObj: MediaInventoryFileType, isComplete = false) {
    let xmlString = '&lt;file ' +
        'type=&quot;' + fileObj.type + '&quot; ' +
        'id=&quot;' + fileObj.id + '&quot; ' +
        'size=&quot;' + fileObj.size + '&quot; ' +
        'md5=&quot;' + fileObj.md5 + '&quot; ' +
        'complete=&quot;' + Number(isComplete) + '&quot; ' +
        'lastChecked=&quot;' + Date.now() + '&quot;';

    // Add fileType when fileObj.type = dependency
    if (fileObj.type === 'dependency') {
        xmlString += ' fileType=&quot;' + fileObj.fileType + '&quot; ';
    }

    xmlString += '/&gt;';

    return xmlString;
}

export function getLogDate() {
    return DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss');
}

export function setExpiry(duration: DurationLike) {
    return DateTime.now().plus(duration).toFormat('yyyy-MM-dd HH:mm:ss');
}

export function stringify(obj: any) {
    let cache: unknown[] | null = [];
    let str = JSON.stringify(obj, function(_key, value) {
        if (typeof value === "object" && value !== null) {
            if (cache !== null && cache.indexOf(value) !== -1) {
                // Circular reference found, discard key
                return;
            }
            // Store value in our collection
            (cache !== null) && cache.push(value);
        }
        return value;
    });
    cache = null; // reset the cache
    return str;
}

export function flatLogObj(logObjArr: any[]) {
    let logStr = '';

    if (logObjArr.length === 0) {
        return logStr;
    }

    (async () => {
        await Promise.all(
            logObjArr.map((logObj, logIndx) => {
                if (logObj === null)  {
                    logStr += '';
                } else if (typeof logObj === 'string') {
                  logStr += ' ' + String(logObj);
                } else if (typeof logObj === 'object') {
                    const logObjKeys = Object.keys(logObj);
                    if (logObjKeys.length > 0) {
                        let shouldParse = true;
                        if (logObjKeys.includes('shouldParse')) {
                            shouldParse = logObj.shouldParse;
                        }

                        if (!shouldParse) {
                            logStr += '';
                        } else {
                            Object.keys(logObj).map(inputKey => {
                                logStr += ' ' + String(inputKey);

                                if (typeof logObj[inputKey] === 'object' || typeof logObj[inputKey] === 'function') {
                                    logStr += '=' + stringify(logObj[inputKey]);
                                } else {
                                    logStr += '=' + String(logObj[inputKey]);
                                }
                            })
                        }
                    }
                } else {
                    logStr += logIndx > 0 ? ' ' : ''
                        + logObj;
                }
            })
        );
    })();

    return logStr;
}

export type FlattenedObject = Record<string, any>;

export interface FlattenOptions {
  maxDepth?: number;
  maxStringLength?: number;
  stringifySafe?: boolean;
}

export interface UnflattenOptions {
  classRegistry?: Map<string, new () => any>;
  reconstructInstances?: boolean; // control instance rehydration
}

const INSTANCE_MARKER = "__class__";

/**
 * Flatten any object into a single-level key/value map.
 * Handles circular refs, arrays, and class instances.
 */
export function flattenObject(
  obj: any,
  parentKey = "",
  result: FlattenedObject = {},
  seen: WeakMap<object, string> = new WeakMap(),
  options: FlattenOptions = {}
): FlattenedObject {
  const { maxDepth = 20, maxStringLength = 300, stringifySafe = true } = options;

  function sanitizeValue(value: any): any {
    if (!stringifySafe) return value;
    if (typeof value === "function") return `[Function: ${value.name || "anonymous"}]`;
    if (typeof value === "symbol") return `[Symbol: ${String(value)}]`;
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "string" && value.length > maxStringLength) {
      return value.slice(0, maxStringLength) + "…";
    }
    return value;
  }

  function _flatten(value: any, keyPath: string, depth: number) {
    if (depth > maxDepth) {
      result[keyPath] = `[Max depth ${maxDepth} reached]`;
      return;
    }

    if (value === null || typeof value !== "object") {
      result[keyPath] = sanitizeValue(value);
      return;
    }

    if (seen.has(value)) {
      result[keyPath] = `[Circular -> ${seen.get(value)}]`;
      return;
    }
    seen.set(value, keyPath || "[root]");

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const newKey = keyPath ? `${keyPath}[${index}]` : `[${index}]`;
        _flatten(item, newKey, depth + 1);
      });
      return;
    }

    const proto = Object.getPrototypeOf(value);
    const isPlainObject = proto === Object.prototype || proto === null;
    if (!isPlainObject) {
      // mark instance type
      const markerKey = keyPath ? `${keyPath}.${INSTANCE_MARKER}` : INSTANCE_MARKER;
      result[markerKey] = value.constructor?.name || "Object";
    }

    for (const [prop, val] of Object.entries(value)) {
      const newKey = keyPath ? `${keyPath}.${prop}` : prop;
      if (typeof val === "object" && val !== null) {
        _flatten(val, newKey, depth + 1);
      } else {
        result[newKey] = sanitizeValue(val);
      }
    }
  }

  _flatten(obj, parentKey, 0);
  return result;
}

/**
 * Unflattens an object back from a flattened map.
 * Optionally reconstructs real class instances using provided registry.
 */
export function unflattenObject(
  flat: FlattenedObject,
  options: UnflattenOptions = {}
): any {
  const { classRegistry, reconstructInstances = false } = options;
  const result: any = {};

  // Sort keys by length so parent keys appear first
  const sortedKeys = Object.keys(flat).sort((a, b) => a.length - b.length);

  for (const flatKey of sortedKeys) {
    const value = flat[flatKey];
    if (!flatKey) continue;

    const parts = flatKey.split(/\.|\[(\d+)\]/).filter(Boolean);
    let current = result;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;

      if (isLast) {
        // handle marker
        if (part === INSTANCE_MARKER && reconstructInstances && typeof value === "string") {
          const ctor = classRegistry?.get(value);
          if (ctor) {
            const parentPath = parts.slice(0, -1);
            let target = result;
            for (const p of parentPath) {
              if (!(p in target)) target[p] = {};
              target = target[p];
            }
            target.__instance__ = new ctor();
          }
        } else {
          current[part] = value;
        }
        continue;
      }

      const nextPart = parts[i + 1];
      const nextIsArray = /^\d+$/.test(nextPart);

      if (!(part in current) || typeof current[part] !== "object" || current[part] === null) {
        current[part] = nextIsArray ? [] : {};
      }

      current = current[part];
    }
  }

  // hydrate back instances only if requested
  function hydrateInstances(obj: any): any {
    if (Array.isArray(obj)) return obj.map(hydrateInstances);
    if (obj && typeof obj === "object") {
      if (obj.__instance__) {
        const instance = obj.__instance__;
        delete obj.__instance__;
        Object.assign(instance, hydrateInstances(obj));
        return instance;
      }
      for (const key of Object.keys(obj)) {
        obj[key] = hydrateInstances(obj[key]);
      }
    }
    return obj;
  }

  return reconstructInstances ? hydrateInstances(result) : result;
}

/**
 * Optional class registry for reconstruction.
 */
export const classRegistry = new Map<string, new () => any>();
export function registerClass(name: string, ctor: new () => any) {
  classRegistry.set(name, ctor);
}

export function submitLogsXmlString(log: LogEntry) {
  const logMessage = log.message;

  let xmlString = '&lt;log date=&quot;' + getLogDate() + '&quot; ' +
    'category=&quot;' + log.category + '&quot;&gt;' +
    '&lt;message&gt;' + logMessage + '&lt;/message&gt;';

    if (log.method !== undefined && String(log.method).length > 0) {
      xmlString += '&lt;method&gt;' + log.method + '&lt;/method&gt;';
    }

    if (log.scheduleId && log.scheduleId !== null) {
      xmlString += '&lt;scheduleId&gt;' + log.scheduleId + '&lt;/scheduleId&gt;';
    }

    if (log.layoutId && log.layoutId !== null) {
      xmlString += '&lt;layoutId&gt;' + log.layoutId + '&lt;/layoutId&gt;';
    }

    if (log.mediaId && log.mediaId !== null) {
      xmlString += '&lt;mediaId&gt;' + log.mediaId + '&lt;/mediaId&gt;';
    }

    // Fill in log alert fields
    if (log.eventType && log.eventType !== null) {
      xmlString += '&lt;eventType&gt;' + log.eventType + '&lt;/eventType&gt;';
    }

    if (log.alertType && log.alertType !== null) {
      xmlString += '&lt;alertType&gt;' + log.alertType + '&lt;/alertType&gt;';
    }

    if (log.refId && log.refId !== null) {
      xmlString += '&lt;refId&gt;' + log.refId + '&lt;/refId&gt;';
    }

    xmlString += '&lt;/log&gt;';

    return xmlString;
}

export function submitStatXmlString(statObj: StatEntry) {
  let statXml = '&lt;stat ' +
    'fromdt=&quot;' + statObj.fromdt + '&quot; ' +
    'todt=&quot;' + statObj.todt + '&quot; ' +
    'type=&quot;' + statObj.type + '&quot; ' +
    'scheduleid=&quot;' + statObj.scheduleid + '&quot; ' +
    'layoutid=&quot;' + statObj.layoutid + '&quot; ' +
    'mediaid=&quot;' + statObj.mediaid + '&quot; ' +
    'count=&quot;' + statObj.count + '&quot; ' +
    'duration=&quot;' + statObj.duration + '&quot; ';

  if (statObj.tag !== null && String(statObj.tag).length > 0) {
    statXml += 'tag=&quot;' + statObj.tag + '&quot; ';
  }

  statXml += '/&gt;';
  
  return statXml;
}
