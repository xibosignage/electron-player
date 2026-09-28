/**
 * Compact, serialisable form of an error for logging.
 *
 * Logging an error object whole goes wrong both ways. An Error's message and
 * stack are not enumerable, so the log flattener drops them and the CMS gets no
 * error text at all. An AxiosError is the opposite: its enumerable config,
 * request (a Node ClientRequest with its socket) and response are flattened in
 * full. Keep what helps diagnose the failure and nothing else.
 */

const MAX_STACK_LINES = 5;
const MAX_BODY_LENGTH = 300;

export type ErrorSummary = {
  name?: string;
  message?: string;
  code?: string | number;
  stack?: string;
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
            ? value.slice(0, MAX_BODY_LENGTH) + '…'
            : value;
        }
      }
      return fields;
    }
    return typeof err === 'string' ? err : String(err);
  }

  const e = err as any;
  const summary: ErrorSummary = {
    name: e.name,
    message: e.message,
    code: e.code ?? e.errno,
    stack: typeof e.stack === 'string'
      ? e.stack.split('\n').slice(0, MAX_STACK_LINES).join('\n')
      : undefined,
  };

  if (e.isAxiosError) {
    const method = e.config?.method;
    summary.method = method ? String(method).toUpperCase() : undefined;
    summary.url = e.config?.url ?? e.config?.baseURL;
    summary.status = e.response?.status ?? e.status;
    summary.statusText = e.response?.statusText || undefined;
    // SOAP faults and CMS error messages come back in the body
    summary.responseData = bodyText(e.response?.data);
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
export function sanitizeLogArgs(args: any[]): any[] {
  const walk = (value: any, depth: number): any => {
    if (isErrorLike(value)) return errorSummary(value);
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
      const next = walk(item, depth + 1);
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
