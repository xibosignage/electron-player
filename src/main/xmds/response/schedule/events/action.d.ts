import { CriteriaType } from '../criteria';
import { ActionInterface, ActionResponseType } from './action';

export declare class Action implements ActionInterface {
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
    
    constructor(response: ActionResponseType);

    getFromDt(): Date;
    getToDt(): Date;
}