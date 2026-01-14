import LoggerLib, { LogMessage, LogTransport } from "./loggerLib";

const nativeConsole = console

export default class ConsoleLib implements Console {
  private readonly context: 'MAIN' | 'RENDERER';
  logger: LoggerLib;

  constructor(context: 'MAIN' | 'RENDERER', transport?: LogTransport) {
    this.context = context;
    this.logger = new LoggerLib(context, transport);
  }

  assert(value?: unknown, message?: unknown, optionalParams?: any[]): void {
    if (value) return;
    const msg = message === undefined ? 'Assertion failed' : message;
    let args = [msg];

    if (optionalParams) {
      args = [...args, ...optionalParams];
    }

    // Emit to native console with context/level prefix
    this._emit('ERROR', args);
    // Also record to the logger
    this.logger.error(args);
  }
  clear(): void {
    throw new Error("Method not implemented.");
  }
  count(_label?: unknown): void {
    throw new Error("Method not implemented.");
  }
  countReset(_label?: unknown): void {
    throw new Error("Method not implemented.");
  }
  dir(_obj?: unknown, _options?: unknown): void {
    throw new Error("Method not implemented.");
  }
  dirxml(_data?: any[]): void {
    throw new Error("Method not implemented.");
  }
  group(_label?: any[]): void {
    throw new Error("Method not implemented.");
  }
  groupCollapsed(_label?: any[]): void {
    throw new Error("Method not implemented.");
  }
  groupEnd(): void {
    throw new Error("Method not implemented.");
  }
  table(_tabularData?: unknown, _properties?: unknown): void {
    throw new Error("Method not implemented.");
  }
  time(_label?: unknown): void {
    throw new Error("Method not implemented.");
  }
  timeEnd(_label?: unknown): void {
    throw new Error("Method not implemented.");
  }
  timeLog(_label?: unknown, _data?: unknown[]): void {
    throw new Error("Method not implemented.");
  }
  timeStamp(_label?: unknown): void {
    throw new Error("Method not implemented.");
  }
  trace(_message?: unknown, _optionalParams?: unknown[]): void {
    throw new Error("Method not implemented.");
  }
  profile(_label?: string): void {
    throw new Error("Method not implemented.");
  }
  profileEnd(_label?: string): void {
    throw new Error("Method not implemented.");
  }

  private _emit(level: LogMessage['level'], args: any[]) {
    const prefix = `%c[${this.context}] [${level}]`;
    const color =
      level === 'ERROR'
        ? 'color: red;'
        : level === 'WARN'
        ? 'color: orange;'
        : 'color: #0ff;';

    const method = (nativeConsole as any)[level.toLowerCase()];
    if (typeof method === 'function') {
      method(prefix, color, ...args);
    }
  }

  _log = nativeConsole.log.bind(console);
  log(...args: any[]) {
    // Pass to native console
    this._emit('LOG', args);
    // Pass to logger
    this.logger.log(args);
  }

  _info = nativeConsole.info.bind(console);
  info(...args: any[]) {
    this._emit('INFO', args);
    this.logger.info(args);
  }

  _debug = nativeConsole.debug.bind(console);
  debug(...args: any[]) {
    this._emit('DEBUG', args);
    this.logger.debug(args);
  }

  _error = nativeConsole.error.bind(console);
  error(...args: any[]) {
    this._emit('ERROR', args);
    this.logger.error(args);
  }

  alert(...args: any[]) {
    this._emit('LOG', args);
    this.logger.alert(args);
  }

  fault(...args: any[]) {
    this._emit('ERROR', args);
    this.logger.fault(args);
  }

  _warn = nativeConsole.warn.bind(console);
  warn(...args: any[]): void {
    this._emit('WARN', args);
  }  
}