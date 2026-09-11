import { app, nativeImage, NativeImage } from 'electron';
import { readdir, readFile, stat } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

import { getPlayerDataDir, isSnap } from '../../main/common/paths';
import { setExpiry } from '../../main/common/parser';
import { FaultCodes } from '../faults/Faults';

/**
 * How old a screenshot may be before whatever produces it is treated as stalled. The file
 * is still submitted, since a stale screenshot beats none, but a fault is raised so the
 * problem is visible in the CMS rather than silently serving an old image.
 */
const STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * A stale screenshot is informational rather than a failure, so the fault is given a short
 * life rather than the default day. The next request raises it again if it still applies.
 */
const STALE_FAULT_EXPIRY = { hours: 1 };

/**
 * Raises and clears faults. Passed down from main, where the Faults instance lives.
 *
 * Screenshot problems fix themselves, so the condition is re-evaluated on every request
 * and whichever fault no longer applies is cleared.
 */
export interface FaultChannel {
  report(code: FaultCodes, reason: string, expires?: string): void;
  clear(code: FaultCodes): void;
}

interface LoadedScreenshot {
  image: NativeImage;
  path: string;
  modifiedAt: Date;
}

/** Name of the screenshot directory within the library */
export const SCREENSHOT_DIR_NAME = 'screenshots';

/**
 * Directory the player reads screenshots from on Wayland, where it cannot capture the
 * screen itself and something the user has set up writes them instead.
 *
 * @returns The absolute path to the screenshot directory
 */
export function getScreenshotDir(): string {
  const userDataPath = app.getPath('userData');

  // Mirrors how config.ts resolves the library
  const library = isSnap()
    ? join(getPlayerDataDir(userDataPath), 'xibo_library')
    : join(app.getPath('documents'), 'xibo_library');

  return join(library, SCREENSHOT_DIR_NAME);
}

/**
 * Create the screenshot directory if it is missing, so the user does not have to.
 *
 * @returns The absolute path to the screenshot directory
 */
export function ensureScreenshotDir(): string {
  const dir = getScreenshotDir();

  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  } catch (error) {
    console.error('[screenshotDirectory] > Could not create the screenshot directory', { dir, error });
  }

  return dir;
}

/**
 * Find the newest usable image in the screenshot directory.
 *
 * Files are chosen by modification time rather than name, so whatever writes them is free
 * to name them however it likes. Anything that does not decode as an image is skipped,
 * which also covers a file caught mid-write.
 *
 * @returns The newest decodable image with its path and timestamp, or null if there is none
 */
async function readLatestScreenshot(): Promise<LoadedScreenshot | null> {
  const dir = getScreenshotDir();

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    console.error('[screenshotDirectory] > Could not read the screenshot directory', { dir, error });
    return null;
  }

  const candidates: { path: string, modifiedAt: Date }[] = [];

  for (const entry of entries) {
    const path = join(dir, entry);

    try {
      const stats = await stat(path);
      if (stats.isFile()) {
        candidates.push({ path, modifiedAt: stats.mtime });
      }
    } catch {
      // Removed between listing and stat, or unreadable. Skip it.
    }
  }

  // Newest first
  candidates.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());

  for (const candidate of candidates) {
    try {
      // Read here rather than with createFromPath, which reads on the main thread
      const contents = await readFile(candidate.path);

      // Anything that is not an image decodes to an empty one, so this doubles as the filter
      const image = nativeImage.createFromBuffer(contents);

      if (!image.isEmpty()) {
        return { image, ...candidate };
      }
    } catch {
      // Removed since it was listed, or unreadable. Try the next one.
    }
  }

  console.error('[screenshotDirectory] > No usable image in the screenshot directory', {
    dir,
    files: entries.length,
  });

  return null;
}

/**
 * Scale an image down so its largest dimension is no more than maxDimension, matching how
 * the CMS screenShotSize setting is applied on the desktopCapturer path.
 *
 * @param image The image to cap
 * @param maxDimension The largest dimension to allow, or zero to leave it alone
 * @returns The image, resized only if it exceeded the cap
 */
function capToMaxDimension(image: NativeImage, maxDimension: number): NativeImage {
  if (maxDimension <= 0) {
    return image;
  }

  const { width, height } = image.getSize();

  if (Math.max(width, height) <= maxDimension) {
    return image;
  }

  // Only one dimension is given, so the other follows the aspect ratio
  return width >= height
    ? image.resize({ width: maxDimension, quality: 'best' })
    : image.resize({ height: maxDimension, quality: 'best' });
}

/**
 * Read the newest screenshot available on disk and return it for submission.
 *
 * The file is never deleted, so if nothing new is written the last screenshot keeps being
 * submitted as a fallback.
 *
 * @param maxDimension The CMS screenShotSize setting, or zero for the image's own size
 * @param faults Optional fault channel, used to raise and clear screenshot faults
 * @returns The screenshot as a base64 PNG, or null if there is none to submit
 */
export async function captureFromScreenshotDir(
  maxDimension: number = 0,
  faults?: FaultChannel,
): Promise<string | null> {
  try {
    const latest = await readLatestScreenshot();

    if (!latest) {
      faults?.report(
        FaultCodes.FaultScreenshotMissing,
        `No screenshot to submit. Check that images are being written to ${getScreenshotDir()}`,
      );

      // Nothing to measure the age of, so a standing stale fault no longer applies
      faults?.clear(FaultCodes.FaultScreenshotStale);

      return null;
    }

    // We have one, so whatever raised the missing fault has been resolved
    faults?.clear(FaultCodes.FaultScreenshotMissing);

    const ageMs = Date.now() - latest.modifiedAt.getTime();

    if (ageMs > STALE_AFTER_MS) {
      const ageMinutes = Math.round(ageMs / 60000);
      const reason = `The submitted screenshot was more than ${STALE_AFTER_MS / 60000} minutes old.`;

      console.warn('[screenshotDirectory] > Submitting a stale screenshot', {
        path: latest.path,
        ageMinutes,
      });

      faults?.report(FaultCodes.FaultScreenshotStale, reason, setExpiry(STALE_FAULT_EXPIRY));
    } else {
      // Fresh again, so clear any stale fault left by an earlier request
      faults?.clear(FaultCodes.FaultScreenshotStale);
    }

    const image = capToMaxDimension(latest.image, maxDimension);

    console.debug('[screenshotDirectory] > Submitting a screenshot from disk', {
      path: latest.path,
      modifiedAt: latest.modifiedAt.toISOString(),
      original: latest.image.getSize(),
      returned: image.getSize(),
      maxDimension,
    });

    return image.toPNG().toString('base64');
  } catch (error) {
    // Nothing was submitted, so report it rather than failing silently on a device
    // nobody is watching
    console.error('[screenshotDirectory] > Failed to read a screenshot from disk', { error });

    faults?.report(
      FaultCodes.FaultScreenshotMissing,
      `Could not read a screenshot from ${getScreenshotDir()}`,
    );

    return null;
  }
}
