/*
 * Copyright (c) 2025 Xibo Signage Ltd
 *
 * Xibo - Digital Signage - https://xibosignage.com
 *
 * This file is part of Xibo.
 *
 * Xibo is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * any later version.
 *
 * Xibo is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Xibo.  If not, see <http://www.gnu.org/licenses/>.
 */
import xml2js from 'xml2js';
// import {DurationLike} from "luxon";

export enum ErrorCodes {
  NotAuthorisedMsg = 'This Display is not authorised.',
  ErrBadResponse = 'ERR_BAD_RESPONSE',
}

/**
 * An error from XMDS.
 */
export class Error {
  code?: string | number;
  message: string = '';

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
    this.response = response;
    this.code = code;
  }

  parse() {
    validateXml(this.response, async (isValid, err) => {
      if (!isValid) {
        console.error('Error::parse - Invalid XML response', {
          response: this.response,
          error: err,
        });
        this.message = this.response;
        return;
      } else {
        console.debug('Error::parse - Valid XML response', {
          response: this.response,
        });

        const parser = new xml2js.Parser();
        const rootDoc = await parser.parseStringPromise(this.response);

        console.debug('[MAIN] Error > rootDoc', {
          response: this.response,
          rootDoc,
        });

        const fault = rootDoc['SOAP-ENV:Envelope']['SOAP-ENV:Body'][0]['SOAP-ENV:Fault'][0];

        if (Boolean(fault)) {
          this.code = fault['faultcode'][0];
          this.message = fault['faultstring'][0];
        }

        console.debug('[MAIN] Error > parse', {
          fault,
        });
      }
    });

    // let expiryDuration: DurationLike = { days: 1 };
    // // Check if we have a valid XML doc
    // if (doc && doc.getElementsByTagName('parsererror').length > 0) {
    //   this.message = response;
    //   expiryDuration = { hours: 1 };
    // }
  }

  getMsg() {
    return this.message;
  }

  getError() {
    return {
      code: this.code,
      message: this.message,
    }
  }
}

export function validateXml(xmlString: string, callback: (isValid: boolean, error: any) => void) {
  const parser = new xml2js.Parser();
  parser.parseString(xmlString, (err, _result) => {
    if (err) {
      // If an error occurs, the XML string is not valid
      callback(false, err);
    } else {
      // If no error, the XML string is considered valid
      callback(true, null);
    }
  });
}

export function handleError(error: any, message?: string) {
  const { response, request, message: errMessage, status } = error;
  let errorObject = {
    message: errMessage,
    status,
  };

  console._log('[handleError]', {
    error,
    response,
    request,
    message,
  })

  if (response) {
    let errResponse: Error = new Error(response.data, response.status);
    errResponse.parse();

    if (errResponse.message === ErrorCodes.NotAuthorisedMsg) {
      throw new Error(errResponse.message);
    }

    return errResponse;
  } else if (request) {
    // request sent but no response received
    errorObject.status = request.status;

    console.error(errorObject.message);

    return errorObject;
  } else {
    errorObject.message = message;
    console.error(errorObject.message);
    console.debug({ error, errorObject });
    return errorObject;
  }
}