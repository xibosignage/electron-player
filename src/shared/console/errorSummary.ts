/**
 * Compact, serialisable form of an error for logging.
 *
 * Logging an error object whole goes wrong both ways. An Error's message and
 * stack are not enumerable, so the log flattener drops them and the CMS gets no
 * error text at all. An AxiosError is the opposite: its enumerable config,
 * request (a Node ClientRequest with its socket) and response are flattened in
 * full. Keep what helps diagnose the failure and nothing else.
 *
 * Stack traces are left out: logs reach the CMS, where users and customers can
 * read them, and a stack exposes install paths and source file names.
 */

const MAX_BODY_LENGTH = 300;

// Home directories, which carry the local username: /home/<user>, /Users/<user>
// (macOS), /root and <drive>:\Users\<user> (either slash). Matched as text because
// the renderer cannot ask the OS for the home directory. The lookbehind skips URL
// paths such as http://cms.example.com/home/..., where a hostname precedes the slash.
// Windows first, so 'D:/Users/jo' is not caught by the '/Users/<user>' pattern.
const HOME_DIR_PATTERNS: [RegExp, string][] = [
  [/\b[A-Za-z]:[\\/]Users[\\/][^\\/\s'"`)]+/g, '~'],
  [/(?<![\w.-])\/(?:home|Users)\/[^/\s'"`)]+(?=\/|\b)/g, '~'],
  [/(?<![\w.-])\/root(?=\/)/g, '~'],
];

/**
 * Replace home directory prefixes with `~`, e.g. an fs error's
 * "open '/home/jo/Documents/xibo_library/1.jpg'" becomes
 * "open '~/Documents/xibo_library/1.jpg'". Keeps which folder was involved
 * without showing the username in logs that reach the CMS.
 */
export function redactPaths(text: string): string {
  return HOME_DIR_PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

const redact = <T>(value: T): T => (typeof value === 'string' ? redactPaths(value) as T : value);

export type ErrorSummary = {
  name?: string;
  message?: string;
  code?: string | number;
  // HTTP (axios) failures
  method?: string;
  url?: string;
  status?: number;
  statusText?: string;
  responseData?: string;
  cause?: ErrorSummary | string | Record<string, unknown>;
};

export function isErrorLike(value: unknown): value is Error {
  return value instanceof Error ||
    (typeof value === 'object' && value !== null &&
      typeof (value as any).message === 'string' &&
      (typeof (value as any).stack === 'string' || (value as any).isAxiosError === true));
}

function bodyText(data: unknown): string | undefined {
  if (data === undefined || data === null || data === '') return undefined;
  let text: string;
  if (typeof data === 'string') {
    text = data;
  } else if ((globalThis as any).Buffer?.isBuffer(data)) {
    text = (data as any).toString('utf8');
  } else {
    try {
      text = JSON.stringify(data);
    } catch {
      text = String(data);
    }
  }
  return text.length > MAX_BODY_LENGTH ? text.slice(0, MAX_BODY_LENGTH) + '…' : text;
}

export function errorSummary(err: unknown, depth = 0): ErrorSummary | string | Record<string, unknown> {
  if (!isErrorLike(err)) {
    // A plain rejection value, e.g. `throw { code, message }`: keep its own simple fields
    if (typeof err === 'object' && err !== null) {
      const fields: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(err)) {
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
          fields[key] = typeof value === 'string' && value.length > MAX_BODY_LENGTH
            ? redactPaths(value.slice(0, MAX_BODY_LENGTH)) + '…'
            : redact(value);
        }
      }
      return fields;
    }
    return redactPaths(typeof err === 'string' ? err : String(err));
  }

  const e = err as any;
  const summary: ErrorSummary = {
    name: e.name,
    message: redact(e.message),
    code: e.code ?? e.errno,
  };

  if (e.isAxiosError) {
    const method = e.config?.method;
    summary.method = method ? String(method).toUpperCase() : undefined;
    summary.url = redact(e.config?.url ?? e.config?.baseURL);
    summary.status = e.response?.status ?? e.status;
    summary.statusText = e.response?.statusText || undefined;
    // SOAP faults and CMS error messages come back in the body
    summary.responseData = redact(bodyText(e.response?.data));
  }

  if (e.cause !== undefined && depth < 1) {
    summary.cause = errorSummary(e.cause, depth + 1);
  }

  for (const key of Object.keys(summary) as (keyof ErrorSummary)[]) {
    if (summary[key] === undefined) delete summary[key];
  }

  return summary;
}

/**
 * Replace error objects in log arguments with their summaries, including errors
 * nested in plain objects or arrays (e.g. `{ error: err }`). Other values are
 * returned untouched, so the cost for ordinary log calls is a shallow walk.
 */
// Object keys that, by convention, hold an error even when it is not an Error
// instance, e.g. `throw { code, message }` logged as `{ error: err }`.
const ERROR_KEYS = /^(error|err|e|reason|cause|exception)$/i;

export function sanitizeLogArgs(args: any[]): any[] {
  const walk = (value: any, depth: number, key?: string): any => {
    if (isErrorLike(value)) return errorSummary(value);
    if (key !== undefined && ERROR_KEYS.test(key) && value !== null && typeof value === 'object' &&
        !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype) {
      return errorSummary(value);
    }
    if (depth >= 3 || value === null || typeof value !== 'object') return value;

    if (Array.isArray(value)) {
      let changed = false;
      const out = value.map((item) => {
        const next = walk(item, depth + 1);
        if (next !== item) changed = true;
        return next;
      });
      return changed ? out : value;
    }

    // Only plain objects; class instances are left as they are
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;

    let out: Record<string, any> | undefined;
    for (const [key, item] of Object.entries(value)) {
      const next = walk(item, depth + 1, key);
      if (next !== item) {
        const copy: Record<string, any> = out ?? { ...value };
        copy[key] = next;
        out = copy;
      }
    }
    return out ?? value;
  };

  return args.map((arg) => walk(arg, 0));
}
