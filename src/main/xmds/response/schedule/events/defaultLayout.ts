import { getLayoutFile } from "../../../../common/fileManager";

export type DependentsFileType = {
    file: string[];
}

export type DefaultLayoutResponseType = {
    $: {
        file: string;
        duration: string;
    };
    dependents: DependentsFileType[];
}

export interface DefaultLayoutInterface {
    readonly response?: DefaultLayoutResponseType;
    readonly file: number;
    readonly duration: number;
    readonly dependents: string[];
    index: number;
    path: string;

    isValid(): Promise<boolean>;
    isInterruptDurationSatisfied(): boolean;
    addCommittedInterruptDuration(): number;
    clone(): DefaultLayout;
    getpath(): string;
}

export class DefaultLayout implements DefaultLayoutInterface {
    response?: DefaultLayoutResponseType;
    file: number;
    duration: number;
    dependents: string[];
    index: number;
    path: string;

    constructor(response?: DefaultLayoutResponseType) {
        this.response = response;
        this.file = 0;
        this.duration = 0;
        this.dependents = <string[]>[];
        this.index = 0;
        this.path = '';

        if (response) {
            this.hydrateFromResponse(response);
        }
    }

    hydrateFromResponse(response: DefaultLayoutResponseType): void {
        this.file = parseInt(response.$.file);
        this.duration = parseInt(response.$.duration);
        this.dependents = [];

        if (response.dependents &&
            response.dependents.length > 0
        ) {
            this.dependents = response.dependents.reduce((a: string[], b) => {
                return [...a, ...b.file];
            }, []);
        }
    }

    hash(): string {
        return '' + this.file + ' (D)';
    }

    async isValid(): Promise<boolean> {
        return Promise.resolve(true);
    }

    isInterruptDurationSatisfied(): boolean {
        return true;
    }

    addCommittedInterruptDuration(): number {
        return this.duration;
    }

    clone(): DefaultLayout {
        return this;
    }

    getpath(): string {
        return getLayoutFile(this.file)?.name;
    }
}
