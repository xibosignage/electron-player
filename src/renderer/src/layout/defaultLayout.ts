/*
 * Copyright (c) Xibo Signage Ltd 2025.
 * All rights reserved.
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