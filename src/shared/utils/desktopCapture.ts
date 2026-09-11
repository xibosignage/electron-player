import { desktopCapturer, screen } from "electron";

import { describeDisplayEnvironment, getSessionType } from "./displayEnvironment";
import { captureFromScreenshotDir, FaultChannel } from "./screenshotDirectory";

// The screenshot interval does not wait for the previous request to finish, so guard
// against overlapping captures stacking up on a device that is slow to respond.
let capturing = false;

/**
 * Work out the size to capture at, honouring the CMS screenShotSize setting.
 *
 * The setting caps the largest dimension, so it is the width on a landscape display and
 * the height on a portrait one, with the other scaling proportionally. Zero means
 * capture at the screen's own size, and we never upscale past it.
 *
 * @param maxDimension The largest dimension to allow, or zero for the screen size
 * @returns The capture size in pixels, preserving the display's aspect ratio
 */
function getCaptureSize(maxDimension: number): { width: number, height: number } {
  const { size, scaleFactor } = screen.getPrimaryDisplay();

  // Display size is reported in device independent pixels, so scale it back up to
  // find what the screen actually renders at.
  const nativeWidth = Math.round(size.width * scaleFactor);
  const nativeHeight = Math.round(size.height * scaleFactor);

  const largest = Math.max(nativeWidth, nativeHeight);
  const scale = maxDimension > 0 ? Math.min(1, maxDimension / largest) : 1;

  return {
    width: Math.round(nativeWidth * scale),
    height: Math.round(nativeHeight * scale),
  };
}

/**
 * Capture the screen with Electron's desktopCapturer.
 *
 * desktopCapturer is asked to scale the capture for us, which keeps memory down on
 * large displays rather than holding a full resolution image before scaling.
 *
 * @param maxDimension The CMS screenShotSize setting, or zero for the screen size
 * @returns The captured screen as a base64 PNG, or null if it could not be captured
 */
async function captureWithDesktopCapturer(maxDimension: number): Promise<string | null> {
  const captureSize = getCaptureSize(maxDimension);

  const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: captureSize,
    })

    // We'll just grab the first screen available
    const primaryScreen = sources[0]

    if (!primaryScreen) {
      console.error('[desktopCapture] > No screen source available to capture');
      return null;
    }

    // thumbnailSize is a request, not a guarantee, so enforce the cap on the result
    let thumbnail = primaryScreen.thumbnail;
    const captured = thumbnail.getSize();
    const cap = Math.max(captureSize.width, captureSize.height);

    if (captured.width > cap || captured.height > cap) {
      thumbnail = captured.width >= captured.height
        ? thumbnail.resize({ width: cap, quality: 'best' })
        : thumbnail.resize({ height: cap, quality: 'best' });
    }

    console.debug('[desktopCapture] > Captured the screen', {
      captureSize,
      captured,
      maxDimension,
      returned: thumbnail.getSize(),
    });

    // 1. Convert the NativeImage to a raw PNG Buffer
    const imageBuffer = thumbnail.toPNG()

    // 2. Convert the Buffer to a base64 string
    return imageBuffer.toString('base64');
}

/**
 * Capture the screen using whichever method the display environment allows.
 *
 * Wayland raises a consent dialog on the sign that nobody is there to accept, so there we
 * read the newest screenshot from a directory instead. Every other environment captures
 * directly with desktopCapturer.
 *
 * @param maxDimension The CMS screenShotSize setting, or zero for the screen size
 * @param faults Optional fault channel, used to raise and clear screenshot faults
 * @returns The screenshot as a base64 PNG, or null if there is none to submit
 */
export async function captureDesktop(
  maxDimension: number = 0,
  faults?: FaultChannel,
): Promise<string | null> {
  if (capturing) {
    console.debug('[desktopCapture] > A capture is already in progress, skipping this request');
    return null;
  }

  capturing = true;

  try {
    if (getSessionType() === 'wayland') {
      console.debug('[desktopCapture] > Wayland session, reading a screenshot from disk', describeDisplayEnvironment());
      return await captureFromScreenshotDir(maxDimension, faults);
    }

    return await captureWithDesktopCapturer(maxDimension);
  } catch (error) {
    console.error('Error capturing desktop:', error);
    return null;
  } finally {
    capturing = false;
  }
}
