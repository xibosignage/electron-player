import { DateTime } from 'luxon';

import { db } from "./database/db";
import FaultsDB from "./database/faultsDB";
import { handleError } from '../../../main/xmds/error/error';

export default class FaultsLib {
    clearDBInterval: NodeJS.Timeout | undefined;

    constructor() {
        // Clear faults table everytime the app starts
        this.clearDB();
    }

    clearDB() {
        (async () => await db.faults.clear())();
    }

    composeFaultObj(data: FaultsDB) {
        let _faultObj = {...data};

        _faultObj.date = DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss');
        _faultObj.expires = undefined;

        if (typeof data === 'object' && Object.keys(data).includes('expires')) {
            _faultObj.expires = data.expires;
        }

        return _faultObj;
    }

    async add(fault: FaultsDB) {
        try {
            const faultExists = await db.faults.get(fault.code);

            if (!faultExists) {
                return Promise.resolve(await db.faults.add(this.composeFaultObj(fault)));
            }

            return faultExists;
        } catch (e) {
            return handleError(e);
        }
    }

    async clearFaults(interval: number) {
        if (this.clearDBInterval !== undefined) {
            clearInterval(this.clearDBInterval);
        }

        this.clearDBInterval = setInterval(async () => {
            await this.clearExpired();
        }, interval * 1000);

        await this.clearExpired();
    }

    async clearExpired() {
        const faults = await db.faults.toArray();
        console.debug('[Faults::clearExpired] Clearing expired faults', {
            faults: faults,
            shouldParse: false,
        });

        const now = DateTime.now().toUnixInteger();

        await Promise.all(faults.map(async fault => {
            let expiry;
            if (fault.expires !== undefined) {
                expiry = DateTime.fromFormat(fault.expires as string, 'yyyy-MM-dd HH:mm:ss').toUnixInteger();
            }

            console.debug('[Faults::clearExpired] Checking expiry', {
                fault: fault,
                expiry: expiry,
                now: now,
                isExpired: expiry && (now > expiry),
                shouldParse: false
            });

            if (expiry && (now > expiry)) {
                await db.faults.delete(fault.code);
            }
        }));
    }

    async toJson() {
        const faults = await db.faults.toArray();
        return JSON.stringify(faults);
    }
}