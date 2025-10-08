import { Layout } from './events/layout';
import { DefaultLayout } from './events/defaultLayout';
import { CommandType, ScheduleInterface } from './schedule';
import { Action } from './events/action';
import { DataConnector } from './events/dataConnector';
import { OverlayLayout } from './events/overlayLayout';

export declare class Schedule implements ScheduleInterface {
    constructor(response: string);

    // Properties
    private readonly response: string;
    filterFrom: string | undefined;
    filterTo: string | undefined;
    generated: string | undefined;
    dependants: string[];
    defaultLayout: DefaultLayout | undefined;
    layouts: Layout[];
    overlays: OverlayLayout[];
    actions: Action[];
    dataConnectors: DataConnector[];
    command?: CommandType | undefined;

    // Methods
    parse(): Promise<void>;
}
