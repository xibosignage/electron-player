import xml2js from 'xml2js';

export const AxiosErrorCodes = {
    ECONNABORTED: 'ECONNABORTED',
    ECONNREFUSED: 'ECONNREFUSED',
    ECONNRESET: 'ECONNRESET',
    EHOSTUNREACH: 'EHOSTUNREACH',
    EPIPE: 'EPIPE',
    ETIMEDOUT: 'ETIMEDOUT',
}

export class XmdsError {
    message: string = '';
    code?: string | number;

    /**
     * Expect message to contain a SOAP Fault, e.g.
     * <?xml version="1.0" encoding="UTF-8"?>
     *   <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
     *     <SOAP-ENV:Body>
     *       <SOAP-ENV:Fault>
     *         <faultcode>Sender</faultcode>
     *         <faultstring>The Server key you entered does not match with the server key at this address</faultstring>
     *       </SOAP-ENV:Fault>
     *     </SOAP-ENV:Body>
     *   </SOAP-ENV:Envelope>
     * @param response
     */
    constructor(private response: string, code?: string | number) {
        this.code = code;
    }

    isValidXmlString(xmlString: string) {
        const parser = new xml2js.Parser();

        return new Promise(resolve => {
            parser.parseString(xmlString, (err, _result) => {
                if (err) {
                    // If an error occurs, the XML string is not valid
                    resolve(false);
                } else {
                    // If no error, the XML string is considered valid
                    resolve(true);
                }
            })
        })
    }

    async parse() {
        const isValidXml = await this.isValidXmlString(this.response);

        if (isValidXml) {
            const parser = new xml2js.Parser();
            const rootDoc = await parser.parseStringPromise(this.response);

            const fault = rootDoc['SOAP-ENV:Envelope']['SOAP-ENV:Body'][0]['SOAP-ENV:Fault'][0];

            if (Boolean(fault)) {
                this.code = fault['faultcode'][0];
                this.message = fault['faultstring'][0];
            }
        } else {
            this.message = this.response;
        }
    }

    getError() {
        return {
            code: this.code,
            message: this.message,
        }
    }
}

export async function handleXmdsError(msg: string, code?: string | number) {
    let _error = new XmdsError(msg, code);

    await _error.parse();

    return _error.getError();
}