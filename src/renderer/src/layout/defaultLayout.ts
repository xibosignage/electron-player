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
export default class DefaultLayout {
    response: Element;
    id: number;
    layoutId: number;
    duration: number;
    dependents: string[];
    index: number;
    width: number;
    height: number;
    path?: string;
    shortPath?: string;

    constructor() {
        this.response = <Element><unknown>null;
        this.id = 0;
        this.layoutId = 0;
        this.duration = 0;
        this.index = 0;
        this.width = 0;
        this.height = 0;

        this.dependents = [];
    }

    hydrateFromElement(element: Element) {
        this.response = element;
        this.id = parseInt(element.getAttribute('file') ?? '0');
        this.layoutId = this.id;
        this.duration = parseInt(element.getAttribute('duration') ?? '10');

        const dependents = element.getElementsByTagName('dependents')[0];

        if (dependents && dependents.children.length > 0) {
            this.dependents = Array.from(dependents.children).reduce((a: string[], b) => {
                return [...a, String(b.textContent)];
            }, []);
        }
    }

    hash() {
        return '' + this.layoutId + ' (D)';
    }

    async isValid() {
        return true;
    }

    isInterrupt() {
        return false;
    }

    addCommittedInterruptDuration() {
    }

    isInterruptDurationSatisfied() {
        return true;
    }

    clone() {
        const _defaultLayout = new DefaultLayout();

        _defaultLayout.path = this.path;
        _defaultLayout.shortPath = this.shortPath;
        _defaultLayout.hydrateFromElement(this.response);

        return _defaultLayout;
    }
}