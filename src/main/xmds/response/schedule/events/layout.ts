import { getLayoutFile } from "../../../../common/fileManager";
import { criteria, CriteriaResponseType, CriteriaType } from "../criteria";

export interface LayoutInterface {
    readonly response: LayoutResponseType;
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
    index: number;
    interruptCommittedDuration: number;
    criteria?: CriteriaType[];

    isValid(): Promise<boolean>;
    isInterruptDurationSatisfied(): boolean;
    addCommittedInterruptDuration(): number;
    clone(): Layout;
    getPath(): string;
}

export type LayoutResponseType = {
    $: {
        cyclePlayback: string;
        duration: string;
        file: string;
        fromdt: string;
        geoLocation: string;
        groupKey: string;
        isGeoAware: string;
        maxPlaysPerHour: string;
        playCount: string;
        priority: string;
        scheduleid: string;
        shareOfVoice: string;
        syncEvent: string;
        todt: string;
    };
    criteria?: CriteriaResponseType[];
}

export class Layout implements LayoutInterface {
    readonly response: LayoutResponseType;
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
    index: number;
    interruptCommittedDuration: number;
    criteria?: CriteriaType[] | undefined;

    constructor(response: LayoutResponseType) {
        this.response = response;
        this.cyclePlayback = response.$.cyclePlayback === '1';
        this.duration = parseInt(response.$.duration);
        this.file = parseInt(response.$.file);
        this.fromDt = response.$.fromdt;
        this.geoLocation = response.$.geoLocation;
        this.groupKey = parseInt(response.$.groupKey);
        this.isGeoAware = response.$.isGeoAware === '1';
        this.maxPlaysPerHour = parseInt(response.$.maxPlaysPerHour);
        this.playCount = parseInt(response.$.playCount);
        this.priority = parseInt(response.$.priority);
        this.scheduleId = parseInt(response.$.scheduleid);
        this.shareOfVoice = parseInt(response.$.shareOfVoice);
        this.syncEvent = response.$.syncEvent === '1';
        this.toDt = response.$.todt;
        this.index = 0;
        this.interruptCommittedDuration = 0;

        if (response.criteria && response.criteria.length > 0) {
            this.criteria = response.criteria.reduce((a: CriteriaType[], b) => {
                return [...a, criteria(b)];
            }, []);
        }
    }

    hash(): string {
        return '' + this.file + (this.isInterrupt() ? ' (I)' : '');
    }

    isInterrupt(): boolean {
        return this.shareOfVoice > 0;
    }

    getFromDt(): Date {
        return new Date(this.fromDt);
    }

    getToDt(): Date {
        return new Date(this.toDt);
    }

    hasCriteria(): boolean {
        if (typeof this.criteria === 'undefined') {
            return false;
        }

        return this.criteria.length > 0;
    }

    async isValid(): Promise<boolean> {
        return true;
    }

    isInterruptDurationSatisfied(): boolean {
        return true;
    }

    addCommittedInterruptDuration(): number {
        return this.interruptCommittedDuration += this.duration;
    }

    clone(): Layout {
        return this;
    }

    getPath(): string {
        return getLayoutFile(this.file)?.name;
    }
}