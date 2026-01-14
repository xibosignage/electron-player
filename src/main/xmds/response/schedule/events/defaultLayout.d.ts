import { DefaultLayoutResponseType, DefaultLayoutInterface } from "./defaultLayout";

export declare class DefaultLayout implements DefaultLayoutInterface {
    constructor(response?: DefaultLayoutResponseType);

    // Properties
    file: number;
    duration: number;
    dependents: string[];

    // Methods
    hydrateFromResponse(): void;
    hash(): string;
}
