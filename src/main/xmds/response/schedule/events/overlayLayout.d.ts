import { CriteriaType } from '../criteria';
import { OverlayLayoutInterface, OverlayLayoutResponseType } from './overlayLayout';

export declare class OverlayLayout implements OverlayLayoutInterface {
    constructor(response: OverlayLayoutResponseType);

    readonly duration: number;
    readonly file: number;
    readonly fromDt: string;
    readonly geoLocation: string;
    readonly isGeoAware: boolean;
    readonly priority: number;
    readonly scheduleId: number;
    readonly toDt: string;
    criteria?: CriteriaType[] | undefined;

    getFromDt(): Date;
    getToDt(): Date;
}
