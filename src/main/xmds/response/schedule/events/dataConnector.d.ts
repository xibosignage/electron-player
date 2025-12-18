import { CriteriaType } from '../criteria';
import { DataConnectorInterface, DataConnectorResponseType } from './dataConnector';

export declare class DataConnector implements DataConnectorInterface {
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

    constructor(response: DataConnectorResponseType);

    getFromDt(): Date;
    getToDt(): Date;
}