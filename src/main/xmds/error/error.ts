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
import { DateTime, DurationLike } from 'luxon';
import { setExpiry } from '../../common/parser';
import { FaultCodes } from '../../../shared/faults/Faults';
import { errorSummary } from '../../../shared/console/errorSummary';
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
      }

      // This runs in a callback nobody awaits, so anything thrown here would be an
      // unhandled rejection. Every failure is caught and logged instead.
      try {
        console.debug('Error::parse - Valid XML response', {
          response: this.response,
        });

        const parser = new xml2js.Parser();
        const rootDoc = await parser.parseStringPromise(this.response);

        console.debug('[MAIN] Error > rootDoc', {
          response: this.response,
          rootDoc,
        });

        // An empty body, or a page from a proxy, parses as XML but is not a SOAP fault.
        const fault = rootDoc?.['SOAP-ENV:Envelope']?.['SOAP-ENV:Body']?.[0]?.['SOAP-ENV:Fault']?.[0];

        if (!fault) {
          this.message = this.response;
          return;
        }

        this.code = fault['faultcode']?.[0];
        this.message = fault['faultstring']?.[0] ?? '';

        if (this.code && this.code === 'Receiver') {
          this.code = String(FaultCodes.FaultBadRequest);
        }

        console.debug('[MAIN] Error > parse', {
          fault,
        });

        let expiryDuration: DurationLike = { days: 1 };
        console.fault(this.message, {
          code: this.code,
          date: DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss'),
          expires: setExpiry(expiryDuration),
          shouldParse: false,
        });
      } catch (error) {
        console.error('Error::parse - Could not read the error response', {
          error: errorSummary(error),
        });
      }
    });
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
  const { response, request, message: errMessage, status } = error ?? {};
  let errorObject = {
    message: errMessage,
    status,
  };

  // Log a summary: a failed request carries its whole config, request (with its
  // socket) and response, which must not be dumped on every failed XMDS call.
  const logData = { context: message, error: errorSummary(error) };

  if (response) {
    console.debug('[handleError] CMS responded with an error', logData);

    let errResponse: Error = new Error(response.data, response.status);
    errResponse.parse();

    if (errResponse.message === ErrorCodes.NotAuthorisedMsg) {
      throw new Error(errResponse.message);
    }

    return errResponse;
  } else if (request) {
    // request sent but no response received
    errorObject.status = request.status;

    console.error('[handleError] No response from the CMS', logData);

    return errorObject;
  } else {
    // Keep the error's own message, e.g. a SOAP fault such as "This Display is not
    // authorised."; the caller's message is only a fallback.
    errorObject.message = errMessage || message;
    console.error('[handleError]', logData);
    return errorObject;
  }
}