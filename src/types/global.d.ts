import { ExtendedConsole } from "@shared/console/ExtendedConsole";
import { CustomConsole } from "@shared/console/CustomConsole";
import { ApiHandler, ConfigData } from "@shared/types";
import { IXlr } from "@xibosignage/xibo-layout-renderer";

export {};

declare global {
    interface Console {
        log: (...data: unknown[]) => void;
        info: (...data: unknown[]) => void;
        debug: (...data: unknown[]) => void;
        warn: (...data: unknown[]) => void;
        error: (...data: unknown[]) => void;
        alert(...data: unknown[]): void;
        fault(...data: unknown[]): void;
        _log(...data: unknown[]): void;
    }

    interface Window {
        __extendedConsole: CustomConsole;
        config: ConfigData
        electron: ElectronApi;
        apiHandler: ApiHandler;
        xlr: IXlr;
    }

    declare var window: Window;
    declare var console: CustomConsole;
}
