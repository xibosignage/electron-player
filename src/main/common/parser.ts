import { InputLayoutType } from "./types";

export function getLayoutIds(layouts: InputLayoutType[]): number[] {
    return layouts.reduce((a: number[], b) => {
        return [...a, b.layoutId];
    }, []);
}
