import { CriteriaType } from '../criteria';
import { LayoutInterface, LayoutResponseType } from './layout';

export declare class Layout implements LayoutInterface {
    readonly cyclePlayback: boolean;
    readonly duration: number;
    readonly file: number;
    readonly fromDt: string;
    readonly geoLocation: string;
    readonly groupKey: number;
    readonly isGeoAware: boolean;
    readonly maxPlaysPerHour: number;
    readonly playCount: number;
    readonly priority: number;
    readonly scheduleId: number;
    readonly shareOfVoice: number;
    readonly syncEvent: boolean;
    readonly toDt: string;
    criteria?: CriteriaType[] | undefined;

    constructor(response: LayoutResponseType);

    hash(): string;
    isInterrupt(): boolean;
    getFromDt(): Date;
    getToDt(): Date;
    hasCriteria(): boolean;
}
