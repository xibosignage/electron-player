import he from 'he';

export default class SubmitLogs {
    readonly status: boolean;

    constructor(response: string) {

        const parser = new DOMParser();
        const rootDoc = parser.parseFromString(response, 'text/xml');

        // Get the encoded XML
        let xml = rootDoc.getElementsByTagName('success')[0].innerHTML;
        xml = he.decode(xml);

        this.status = Boolean(xml);
    }
}