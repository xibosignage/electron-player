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

  async parse() {
    const isValidXml = await isValidXmlString(this.response);

    if (isValidXml) {
      const parser = new xml2js.Parser();
      const rootDoc = await parser.parseStringPromise(this.response);

      console.debug('[MAIN] Error > rootDoc', {
        response: this.response,
        rootDoc,
      });
      
      // this.code = doc.getElementsByTagName('faultcode')[0]?.innerHTML;
      // this.message = doc.getElementsByTagName('faultstring')[0]?.innerHTML;
    } else {
      this.message = this.response;
    }

    // let expiryDuration: DurationLike = { days: 1 };
    // // Check if we have a valid XML doc
    // if (doc && doc.getElementsByTagName('parsererror').length > 0) {
    //   this.message = response;
    //   expiryDuration = { hours: 1 };
    // }
  }
}

export function isValidXmlString(xmlString: string) {
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

export function handleError(error: any, message?: string) {
    const { response, request, message: errMessage, status } = error;
    let errorObject = {
        message: errMessage,
        status,
    };

    if (response) {
      let errorMsg: string[] = [];

      if (String(response.data).length > 0) {
        errorMsg.push('response.data=' + response.data);
      }

      if (String(message).length > 0) {
        errorMsg.push(message as string);
      }

      if (String(errMessage).length > 0) {
        errorMsg.push(errMessage);
      }

      errorObject.message = errorMsg.join(' - ');
      errorObject.status = response.status;

      let errResponse: Error = new Error(errorObject.message);
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
        console.debug({error, errorObject});
        return errorObject;
    }
}