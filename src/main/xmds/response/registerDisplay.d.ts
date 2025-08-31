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

/**
 * Register Display Response.
 */
export declare class RegisterDisplay {
    readonly status: number;
    readonly code: string;
    readonly message: string;
    readonly checkSchedule: string;
    readonly checkRf: string;
    readonly date: string;
    readonly timezone: string;
    readonly versionInstructions: string;
    private readonly settings;
    /**
     * Expect either an awaiting auth message, or settings.
     * <?xml version="1.0" encoding="UTF-8"?>
     * <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="urn:xmds" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/" SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
     *     <SOAP-ENV:Body>
     *         <ns1:RegisterDisplayResponse>
     *             <ActivationMessage xsi:type="xsd:string">&lt;?xml version="1.0"?&gt;
     * &lt;display status="1" code="ADDED" message="Display is now Registered and awaiting Authorisation from an Administrator in the CMS" checkSchedule="" checkRf=""/&gt;
     * </ActivationMessage>
     *      OR
     *              <ActivationMessage xsi:type="xsd:string">&lt;?xml version="1.0"?&gt;
     *                  &lt;display date="2024-03-17 13:15:24" timezone="Europe/London" status="0" code="READY" message="Display is active and ready to start." version_instructions="" checkSchedule="" checkRf=""&gt;&lt;CollectInterval type="int"&gt;300&lt;/CollectInterval&gt;....
     *         </ns1:RegisterDisplayResponse>
     *     </SOAP-ENV:Body>
     * </SOAP-ENV:Envelope>
     * @param response
     */
    constructor(response: string);
    getSetting(setting: string, defaultValue: any): any;
}
