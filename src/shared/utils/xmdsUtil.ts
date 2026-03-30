import { AxiosResponse } from "axios";
import { Xmds } from "../../main/xmds/xmds";
import { captureDesktop } from "./desktopCapture";

export async function xmdsMakeScreenshot(xmds: Xmds): Promise<AxiosResponse<any, any, {}> | Error | {
    message: any;
    status?: any;
} | undefined> {
    const stream = await captureDesktop();
    console.debug('[Xmds::on("registered")] > [xmdsMakeScreenshot] > Requesting a screenshot', {
        method: 'captureDesktop',
        stream: stream ? 'Captured successfully' : 'Failed to capture',
    });

    console.debug('[Xmds::on("registered")] > [xmdsMakeScreenshot] > Sending captured screenshot', {
        method: 'xmds.screenshot',
        stream,
    });

    return await xmds.screenshot(stream);
}
