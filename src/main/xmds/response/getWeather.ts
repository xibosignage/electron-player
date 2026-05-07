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

/**
 * Parses the XMDS `GetWeather` SOAP response into a structured weather data object.
 *
 * The CMS returns weather data as a JSON string embedded inside the `<data>` element
 * of the SOAP envelope. This class handles the XML unwrapping and JSON deserialization.
 */
export class GetWeather {
  data: Record<string, any>;

  private readonly response: string;

  constructor(response: string) {
    this.response = response;
    this.data = {};
  }

  async parse() {
    const parser = new xml2js.Parser();
    const rootDoc = await parser.parseStringPromise(this.response);

    // Navigate SOAP envelope to find the response body
    const body = rootDoc['SOAP-ENV:Envelope']['SOAP-ENV:Body'][0];
    const responseKey = Object.keys(body)[0];
    const responseBody = body[responseKey][0];

    // Extract <data> element text content (contains JSON)
    const dataContent = responseBody.data?.[0];

    if (!dataContent) {
      console.error('[GetWeather::parse] No data element found in response');
      return;
    }

    try {
      const raw = typeof dataContent === 'string' ? dataContent : dataContent._;
      this.data = JSON.parse(raw);
    } catch (e) {
      console.error('[GetWeather::parse] Failed to parse weather data JSON', e);
    }
  }
}
