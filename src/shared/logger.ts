export const LOGGER_CHANNEL = 'shared:logger';

// Define a structured type for messages
export interface LogMessage {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'fault';
  context: 'main' | 'renderer';
  args: any[];
  timestamp: number;
}
