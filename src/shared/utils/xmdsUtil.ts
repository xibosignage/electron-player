import { AxiosResponse } from "axios";
import { Xmds } from "../../main/xmds/xmds";
import { captureDesktop } from "./desktopCapture";
import { FaultChannel } from "./screenshotDirectory";

export async function xmdsMakeScreenshot(
    xmds: Xmds,
    maxDimension: number = 0,
    faults?: FaultChannel,
): Promise<AxiosResponse<any, any, {}> | Error | {
    message: any;
    status?: any;
} | undefined> {
    const stream = await captureDesktop(maxDimension, faults);
    console.debug('[xmdsUtils] > [xmdsMakeScreenshot] > Requesting a screenshot', {
        method: 'captureDesktop',
        maxDimension,
        stream: stream ? 'Captured successfully' : 'Failed to capture',
    });

    console.debug('[xmdsUtils] > [xmdsMakeScreenshot] > Sending captured screenshot', {
        method: 'xmds.screenshot',
        stream,
    });

    return await xmds.screenshot(stream);
}
