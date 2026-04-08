import { SspAd } from "../sspAd";

export default class SspLayout {
    ad: SspAd|null;
    file: number;
    layoutId: number;
    duration: number;
    dependents: string[];
    width: number;
    height: number;
    index: number;

    shareOfVoice: number = 0;
    interruptCommittedDuration: number = 0;
    readonly response = '';

    constructor() {
        this.ad = null;
        this.file = -1;
        this.layoutId = this.file;
        this.duration = 0;
        this.width = 0;
        this.height = 0;
        this.index = 0;

        this.dependents = [];
    }

    hash() {
        return 'SSP';
    }

    async isValid() {
        // TODO: how do we know at this point?
        return true;
    }

    isInterrupt() {
        return true;
    }

    addCommittedInterruptDuration() {
        this.interruptCommittedDuration += this.duration;
    }

    isInterruptDurationSatisfied() {
        return this.interruptCommittedDuration >= this.shareOfVoice;
    }

    clone() {
        const _sspLayout = new SspLayout();

        _sspLayout.width = this.width;
        _sspLayout.height = this.height;

        return _sspLayout;
    }
}
