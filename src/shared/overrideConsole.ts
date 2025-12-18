import ConsoleLib from './consoleLib';
import { LogTransport } from './loggerLib';

export function overrideConsole(context: 'MAIN' | 'RENDERER', transport?: LogTransport) {
  const custom = new ConsoleLib(context, transport);
  // Override global console
  (globalThis.console as any) = custom;
}
