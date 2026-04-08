import { Layout, LayoutResponseType } from "./layout";

export class OverlayLayout extends Layout {
    readonly isOverlay = true;

    constructor(response: LayoutResponseType) {
        super(response);
    }
}