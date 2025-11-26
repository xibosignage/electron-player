import { v4 as uuidv4 } from 'uuid';
import Dexie from 'dexie';
import { DateTime } from 'luxon';
import he from 'he';

import LogsDB from './database/logsDB';
import { flatLogObj, getLogDate } from '../../../main/common/parser';

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
export const GetLogsThreshold = 100;

export default class LoggerLib {
    table!: Dexie.Table<LogsDB, string>;
    private logLevel: string = 'error';

    public setLogLevel(logLevel: string) {
        this.logLevel = logLevel;
    }

    public getLogLevel() {
        return this.logLevel;
    }

    async getLogs(size = 0, id?: number, _options?: Partial<LogsDB>) {
        if (size === 0) {
            return Promise.resolve(await this.table.toArray());
        }

        if (id) {
            return Promise.resolve(await this.table.where('uid').equals(id).sortBy('timestamp'));
        }

        let results: LogsDB[] = [];
        if (_options && _options.category === 'Error') {
            results = await this.table.where('category').anyOfIgnoreCase([_options.category, 'event']).limit(size).reverse().sortBy('timestamp');
        } else if (!_options || (_options && (
            _options.category === 'Audit' ||
            _options.category === 'Debug' ||
            _options.category === 'Off'
        ))) {
            if (_options?.category === 'Off') {
                results = await this.table.where('category').equals('event')
                    .limit(size).reverse().sortBy('timestamp');
            } else {
                results = await this.table.limit(size).reverse().sortBy('timestamp');
            }
        }

        return Promise.resolve(results);
    }

    async getLogsCount () {
        return Promise.resolve(await this.table.count());
    }

    async deleteLogs(logs: LogsDB[]) {
        const logUIds = logs.reduce((a: string[], b) => [...a, b.uid], []);
        return Promise.resolve(await this.table.bulkDelete(logUIds));
    }

    // @NOTE: loglevel = audit | error | off
    // audit = send everything
    // error = error only
    // off = turn off logging
    // display alert for service worker version upgrade
    logObj(logObjInput: any[], category: LogCategoryType) {
        const logObjOutput: any = {
            uid: uuidv4(),
            date: getLogDate(),
            method: undefined,
            scheduleId: undefined,
            layoutId: undefined,
            mediaId: undefined,
            eventType: undefined,
            alertType: undefined,
            refId: undefined,
            timestamp: DateTime.now().toMillis(),
        };
        
        let consoleDataObj: any = {};

        // Parse consoleData and check for possible submitLogs params
        if (logObjInput.length > 1) {
            if (typeof logObjInput[1] === 'object') {
                consoleDataObj = logObjInput[1];
            }
        }

        if (consoleDataObj && Boolean(consoleDataObj['scheduleId'])) {
            logObjOutput.scheduleId = consoleDataObj['scheduleId'];
        }

        if (consoleDataObj && Boolean(consoleDataObj['layoutId'])) {
            logObjOutput.layoutId = consoleDataObj['layoutId'];
        }

        if (consoleDataObj && Boolean(consoleDataObj['mediaId'])) {
            logObjOutput.mediaId = consoleDataObj['mediaId'];
        }

        if (consoleDataObj && Boolean(consoleDataObj['method'])) {
            logObjOutput.method = consoleDataObj['method'];
        }

        logObjOutput.category = category;

        // Check for log alert props
        if (consoleDataObj && Boolean(consoleDataObj['eventType'])) {
            logObjOutput.eventType = consoleDataObj['eventType'];
        }

        if (consoleDataObj && Boolean(consoleDataObj['alertType'])) {
            logObjOutput.alertType = consoleDataObj['alertType'];
        }

        if (consoleDataObj && Boolean(consoleDataObj['refId'])) {
            logObjOutput.refId = consoleDataObj['refId'];
        }

        let logMsg = '';
        if (logObjInput.length > 0) {
            if (typeof logObjInput[0] === 'string') {
                // Parse message if an XML string
                const parser = new DOMParser();
                const xmlDoc = parser.parseFromString(logObjInput[0], 'text/xml');
                const faultBody = xmlDoc.getElementsByTagName('SOAP-ENV:Fault');

                logMsg = logObjInput[0];

                if (faultBody.length > 0) {
                    logMsg = faultBody[0].innerHTML;
                } else if (xmlDoc && xmlDoc.getElementsByTagName('parsererror').length === 0) {
                    logMsg = logObjInput[0];
                }

            } else if (typeof logObjInput[0] === 'object') {
                logMsg = flatLogObj([logObjInput[0]]);
            }
        }

        // Remove log message and process remaining params
        logObjInput.shift();

        if (logObjInput.length > 0) {
            logMsg += flatLogObj(logObjInput);
        }

        logMsg = "<![CDATA[" + logMsg + "]]>";

        logObjOutput.message = he.encode(logMsg);

        return logObjOutput;
    }

    /**
     * Custom logger for console.log
     * @param data console.log arguments
     * data[0] as message
     * data[1] can be an object
     */
    // category = Audit
    async log(data: any[]) {
        if (this.logLevel === 'off' || this.logLevel === 'error') {
            return;
        }

        await this.table.add(this.logObj(data, 'Audit'));
    }

    // category = Audit
    async debug(data: any[]) {
        if (this.logLevel === 'off' || this.logLevel === 'error') {
            return;
        }

        await this.table.add(this.logObj(data, 'Audit'));
    }

    // category = Debug
    async info(data: any[]) {
        if (this.logLevel === 'off' || this.logLevel === 'error') {
            return;
        }

        await this.table.add(this.logObj(data, 'Debug'));
    }

    // category = Error
    async error(data: any[]) {
        if (this.logLevel === 'off' || this.logLevel !== 'error') {
            return;
        }

        await this.table.add(this.logObj(data, 'Error'));
    }

    // category = event
    async alert(data: any[]) {
        await this.table.add(this.logObj(data, 'event'));
    }
}