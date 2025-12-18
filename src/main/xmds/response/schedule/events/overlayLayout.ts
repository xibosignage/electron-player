import { criteria, CriteriaResponseType, CriteriaType } from "../criteria";

export type OverlayLayoutResponseType = {
    $: {
        duration: string;
        file: string;
        fromdt: string;
        geoLocation: string;
        isGeoAware: string;
        priority: string;
        scheduleid: string;
        todt: string;
    },
    criteria?: CriteriaResponseType[];
}

export interface OverlayLayoutInterface {
    readonly duration: number;
    readonly file: number;
    readonly fromDt: string;
    readonly geoLocation: string;
    readonly isGeoAware: boolean;
    readonly priority: number;
    readonly scheduleId: number;
    readonly toDt: string;
    criteria?: CriteriaType[];

    getFromDt(): Date;
    getToDt(): Date;
}

export class OverlayLayout implements OverlayLayoutInterface {
    readonly duration: number;
    readonly file: number;
    readonly fromDt: string;
    readonly geoLocation: string;
    readonly isGeoAware: boolean;
    readonly priority: number;
    readonly scheduleId: number;
    readonly toDt: string;
    criteria?: CriteriaType[] | undefined;

    constructor(response: OverlayLayoutResponseType) {
        this.duration = parseInt(response.$.duration);
        this.file = parseInt(response.$.file);
        this.fromDt = response.$.fromdt;
        this.geoLocation = response.$.geoLocation;
        this.isGeoAware = response.$.isGeoAware === '1';
        this.priority = parseInt(response.$.priority);
        this.scheduleId = parseInt(response.$.scheduleid);
        this.toDt = response.$.todt;

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