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

    getXlf(): string {
        if (!this.ad) return '';
        return '<?xml version="1.0"?>\n' +
          '<layout schemaVersion="1" width="' + this.width + '" height="' + this.height + '" bgcolor="#000000" background="">\n' +
          '\t<region id="axe" width="' + this.width + '" height="' + this.height + '" top="0" left="0">\n' +
          '\t\t<media id="axe" type="' + this.ad.xiboType + '" duration="' + this.duration + '" lkid="1" schemaVersion="1">\n' +
          '\t\t\t<options>\n' +
          '\t\t\t\t<uri>' + this.ad.url + '</uri>\n' +
          '\t\t\t</options>\n' +
          '\t\t\t<raw/>\n' +
          '\t\t</media>\n' +
          '\t\t<options/>\n' +
          '\t</region>\n' +
          '</layout>\n';
    }

    clone() {
        const _sspLayout = new SspLayout();

        _sspLayout.width = this.width;
        _sspLayout.height = this.height;

        return _sspLayout;
    }
}
