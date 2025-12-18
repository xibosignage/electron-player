import { criteria, CriteriaResponseType, CriteriaType } from "../criteria";

export type DataConnectorResponseType = {
    $: {
        dataParams: string;
        dataSetId: string;
        duration: string;
        fromdt: string;
        geoLocation: string;
        isGeoAware: string;
        js: string;
        priority: string;
        scheduleid: string;
        todt: string;
    },
    criteria?: CriteriaResponseType[];
}

export interface DataConnectorInterface {
    readonly dataParams: string;
    readonly dataSetId: number;
    readonly duration: number;
    readonly fromDt: string;
    readonly geoLocation: string;
    readonly isGeoAware: boolean;
    readonly js: string;
    readonly priority: number;
    readonly scheduleId: number;
    readonly toDt: string;
    criteria?: CriteriaType[];

    getFromDt(): Date;
    getToDt(): Date;
}

export class DataConnector implements DataConnectorInterface {
    readonly dataParams: string;
    readonly dataSetId: number;
    readonly duration: number;
    readonly fromDt: string;
    readonly geoLocation: string;
    readonly isGeoAware: boolean;
    readonly js: string;
    readonly priority: number;
    readonly scheduleId: number;
    readonly toDt: string;
    criteria?: CriteriaType[] | undefined;
    
    constructor(response: DataConnectorResponseType) {
        this.dataParams = response.$.dataParams;
        this.dataSetId = parseInt(response.$.dataSetId);
        this.duration = parseInt(response.$.duration);
        this.fromDt = response.$.fromdt;
        this.geoLocation = response.$.geoLocation;
        this.isGeoAware = response.$.isGeoAware === '1';
        this.js = response.$.js;
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