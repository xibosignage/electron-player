import xml2js from 'xml2js';
import { v4 as uuidv4 } from 'uuid';
import { DateTime } from 'luxon';
import he from 'he';

import { flatLogObj, getLogDate } from "../main/common/parser";

export type LogCategoryType = 'Audit' | 'Debug' | 'Error' | 'Fault' | 'Off' | 'event';
export type LogAlertEventType = 'Display Up' |
    'Display Down' |
    'App Start' |
    'Power Cycle' |
    'Network Cycle' |
    'TV Monitoring' |
    'Player Fault' |
    'Command' |
    'Other';
export type LogAlertType = 'both' | 'start' | 'end';
export const LogsThreshold = 100;

export interface LogTransport {
  write: (log: LogMessage) => void;
}

// Define a structured type for messages
export interface LogMessage {
  uid: string;
  date: string;
  level: 'LOG' | 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' | 'FAULT' | 'event';
  context: 'MAIN' | 'RENDERER';
  message: string;
  timestamp: number;
  method?: string;
  scheduleId?: number;
  layoutId?: number;
  mediaId?: number;
  category?: LogCategoryType;
  eventType?: LogAlertEventType;
  alertType?: LogAlertType;
  refId?: number;
}

export default class LoggerLib {
  logLevel: 'error' | 'audit' | 'debug' | 'off' = 'audit';
  logCategory: LogCategoryType = 'Error';
  alertType: LogAlertType = 'both';
  
  private readonly context: 'MAIN' | 'RENDERER';
  private readonly transport?: LogTransport;

  constructor(context: 'MAIN' | 'RENDERER', transport?: LogTransport) {
    this.context = context;
    this.transport = transport;
  }

  async parse(input: any[], category: LogCategoryType): Promise<LogMessage> {
    const record: LogMessage = {
      uid: uuidv4(),
      date: getLogDate(),
      level: 'LOG',
      context: this.context,
      message: '',
      method: undefined,
      scheduleId: undefined,
      layoutId: undefined,
      mediaId: undefined,
      eventType: undefined,
      alertType: undefined,
      refId: undefined,
      timestamp: DateTime.now().toMillis(),
    };
    
    let consoleDataObj: Partial<LogMessage> | undefined = undefined;

    // Parse consoleData and check for possible submitLogs params
    if (input.length > 1) {
        if (typeof input[1] === 'object' && input[1] !== null) {
            consoleDataObj = input[1];
        }
    }

    if (consoleDataObj && Boolean(consoleDataObj['scheduleId'])) {
        record.scheduleId = consoleDataObj['scheduleId'];
    }

    if (consoleDataObj && Boolean(consoleDataObj['layoutId'])) {
        record.layoutId = consoleDataObj['layoutId'];
    }

    if (consoleDataObj && Boolean(consoleDataObj['mediaId'])) {
        record.mediaId = consoleDataObj['mediaId'];
    }

    if (consoleDataObj && Boolean(consoleDataObj['method'])) {
        record.method = consoleDataObj['method'];
    }

    record.category = category;

    // Check for log alert props
    if (consoleDataObj && Boolean(consoleDataObj['eventType'])) {
        record.eventType = consoleDataObj['eventType'];
    }

    if (consoleDataObj && Boolean(consoleDataObj['alertType'])) {
        record.alertType = consoleDataObj['alertType'];
    }

    if (consoleDataObj && Boolean(consoleDataObj['refId'])) {
        record.refId = consoleDataObj['refId'];
    }

    let logMsg = '';
    if (input.length > 0) {
        if (typeof input[0] === 'string') {
          
          try {

            // const parser = new xml2js.Parser();
            // const rootDoc = await parser.parseStringPromise(input[0]);
    
            // // Get the encoded XML
            // const faultBody = rootDoc["SOAP-ENV:Fault"][0];
            
            // console.log({ faultBody });
          } catch (err) {
            // Input might be not XML and must be HTML
            console.error(err);
          }

          logMsg = input[0];

          // if (faultBody.length > 0) {
          //     logMsg = faultBody[0].innerHTML;
          // } else if (xmlDoc && xmlDoc.getElementsByTagName('parsererror').length === 0) {
          //     logMsg = input[0];
          // }

        } else if (typeof input[0] === 'object' && input[0] !== null) {
            logMsg = flatLogObj([input[0]]);
        }
    }

    // Remove log message and process remaining params
    input.shift();

    if (input.length > 0) {
        logMsg += flatLogObj(input);
    }

    logMsg = "<![CDATA[" + logMsg + "]]>";

    record.message = he.encode(logMsg);

    return record;
  }

  private logToTransport(log: LogMessage) {
    this.transport?.write(log);
  }

  async log(data: any[]) {
    if (this.logLevel === 'off' || this.logLevel === 'error') return;

    const logRecord = await this.parse(data, 'Audit');
    logRecord.level = 'LOG';
    this.logToTransport(logRecord);
  }

  async debug(data: any[]) {
    if (this.logLevel === 'off' || this.logLevel === 'error') return;

    const logRecord = await this.parse(data, 'Audit');
    logRecord.level = 'DEBUG';
    this.logToTransport(logRecord);
  }

  async info(data: any[]) {
    if (this.logLevel === 'off' || this.logLevel === 'error') return;

    const logRecord = await this.parse(data, 'Debug');
    logRecord.level = 'INFO';
    this.logToTransport(logRecord);
  }

  async error(data: any[]) {
    if (this.logLevel === 'off' || this.logLevel !== 'error') return;

    const logRecord = await this.parse(data, 'Error');
    logRecord.level = 'ERROR';
    this.logToTransport(logRecord);
  }

  async alert(data: any[]) {
    const logRecord = await this.parse(data, 'event');
    logRecord.level = 'event';
    this.logToTransport(logRecord);
  }

  async fault(data: any[]) {
    const logRecord = await this.parse(data, 'Fault');
    logRecord.level = 'FAULT';
    this.logToTransport(logRecord);
  }
}