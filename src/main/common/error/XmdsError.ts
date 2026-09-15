import xml2js from 'xml2js';

export const AxiosErrorCodes = {
    ECONNABORTED: 'ECONNABORTED',
    ECONNREFUSED: 'ECONNREFUSED',
    ECONNRESET: 'ECONNRESET',
    EHOSTUNREACH: 'EHOSTUNREACH',
    EPIPE: 'EPIPE',
    ETIMEDOUT: 'ETIMEDOUT',
}

/**
 * Turns a request that never produced a usable response into a sentence that can be shown
 * on the configuration page.
 *
 * @returns a non-empty description, whatever the request failed with.
 */
export function describeRequestFailure(error: any): string {
    const status = error?.response?.status;

    if (status !== undefined) {
        return `The CMS returned HTTP ${status}. Check the CMS Address.`;
    }

    if (error?.code === AxiosErrorCodes.ECONNREFUSED) {
        return 'Nothing is listening at that address. Check the CMS Address and port.';
    }

    if (error?.code === AxiosErrorCodes.ETIMEDOUT || error?.code === AxiosErrorCodes.ECONNABORTED) {
        return 'The CMS did not respond in time. Check the CMS Address and your connection.';
    }

    if (error?.code === AxiosErrorCodes.EHOSTUNREACH) {
        return 'That host could not be reached. Check the CMS Address and your connection.';
    }

    if (error?.code) {
        return `Could not reach the CMS (${error.code}). Check the CMS Address.`;
    }

    return error?.message || 'Could not reach the CMS. Check the CMS Address.';
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

            // A body can be valid XML without being a SOAP fault.
            const fault = rootDoc?.['SOAP-ENV:Envelope']?.['SOAP-ENV:Body']?.[0]?.['SOAP-ENV:Fault']?.[0];

            if (Boolean(fault)) {
                this.code = fault['faultcode']?.[0] ?? this.code;
                this.message = fault['faultstring']?.[0] ?? '';
            }
        }

        if (this.message === '') {
            console.error('[XmdsError] Response carried no SOAP fault to report', {
                code: this.code,
                body: String(this.response).slice(0, 500),
            });

            this.message = this.code === undefined
                ? 'The CMS returned an unexpected response. Check the CMS Address.'
                : `The CMS returned an unexpected response (${this.code}). Check the CMS Address.`;
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