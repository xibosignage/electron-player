import { criteria, CriteriaResponseType, CriteriaType } from "../criteria";

export type ActionResponseType = {
    $: {
        actionType: string;
        commandCode: string;
        duration: string;
        fromdt: string;
        geoLocation: string;
        isGeoAware: string;
        layoutCode: string;
        priority: string;
        scheduleid: string;
        todt: string;
        triggerCode: string;
    };
    criteria?: CriteriaResponseType[];
}

export interface ActionInterface {
    readonly actionType: string;
    readonly commandCode: string;
    readonly duration: number;
    readonly fromDt: string;
    readonly geoLocation: string;
    readonly isGeoAware: boolean;
    readonly layoutCode: string;
    readonly priority: number;
    readonly scheduleId: number;
    readonly toDt: string;
    readonly triggerCode: string;
    criteria?: CriteriaType[];

    getFromDt(): Date;
    getToDt(): Date;
}

export class Action implements ActionInterface {
    readonly actionType: string;
    readonly commandCode: string;
    readonly duration: number;
    readonly fromDt: string;
    readonly geoLocation: string;
    readonly isGeoAware: boolean;
    readonly layoutCode: string;
    readonly priority: number;
    readonly scheduleId: number;
    readonly toDt: string;
    readonly triggerCode: string;
    criteria?: CriteriaType[] | undefined;

    constructor(response: ActionResponseType) {
        this.actionType = response.$.actionType;
        this.commandCode = response.$.commandCode;
        this.duration = parseInt(response.$.duration);
        this.fromDt = response.$.fromdt;
        this.geoLocation = response.$.geoLocation;
        this.isGeoAware = response.$.isGeoAware === '1';
        this.layoutCode = response.$.layoutCode;
        this.priority = parseInt(response.$.priority);
        this.scheduleId = parseInt(response.$.scheduleid);
        this.toDt = response.$.todt;
        this.triggerCode = response.$.triggerCode;

        if (response.criteria && response.criteria.length > 0) {
            this.criteria = response.criteria.reduce((a: CriteriaType[], b) => {
                return [...a, criteria(b)];
            }, []);
        }
    }

    getFromDt(): Date {
        return new Date(this.fromDt);
    }

    getToDt(): Date {
        return new Date(this.toDt);
    }
}