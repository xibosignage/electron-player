/**
 * Helpers for identifying the Linux display environment.
 *
 * Screen capture behaves very differently depending on the display server, and to a
 * lesser extent the desktop environment, so several parts of the player need to know
 * which one they are running under:
 *
 *  - X11 lets any client read the whole screen, so capture works with no permission.
 *  - Wayland does not, and routes capture through xdg-desktop-portal, which raises a
 *    consent dialog the player cannot answer unattended.
 *
 * These read environment variables only, so they are cheap and safe to call often.
 */

export type SessionType = 'wayland' | 'x11' | 'unknown';

/**
 * @returns Whether the player is running on Linux
 */
export function isLinux(): boolean {
  return process.platform === 'linux';
}

/**
 * Identify the display server backing the current session.
 *
 * @returns 'wayland', 'x11', or 'unknown' when it cannot be determined
 */
export function getSessionType(): SessionType {
  if (!isLinux()) {
    return 'unknown';
  }

  const sessionType = (process.env.XDG_SESSION_TYPE ?? '').toLowerCase();
  if (sessionType === 'wayland' || sessionType === 'x11') {
    return sessionType;
  }

  // Minimal and kiosk sessions do not always set XDG_SESSION_TYPE. Every Wayland
  // compositor sets WAYLAND_DISPLAY, and DISPLAY without it means we are on X11.
  if (process.env.WAYLAND_DISPLAY) {
    return 'wayland';
  }
  if (process.env.DISPLAY) {
    return 'x11';
  }

  return 'unknown';
}

/**
 * @returns Whether the current session is running on Wayland
 */
export function isWayland(): boolean {
  return getSessionType() === 'wayland';
}

/**
 * Identify the desktop environment, lowercased for matching.
 *
 * XDG_CURRENT_DESKTOP may be a colon separated list, for example `ubuntu:GNOME`, so
 * callers should test with `includes` rather than comparing the whole string.
 *
 * @returns The desktop environment, or an empty string when it cannot be determined
 */
export function getDesktopEnvironment(): string {
  return (process.env.XDG_CURRENT_DESKTOP ?? process.env.DESKTOP_SESSION ?? '').toLowerCase();
}

/**
 * Summarise the display environment for logs and fault reports.
 *
 * @returns The platform, session type and desktop environment
 */
export function describeDisplayEnvironment(): {
  platform: string;
  sessionType: SessionType;
  desktop: string;
} {
  return {
    platform: process.platform,
    sessionType: getSessionType(),
    desktop: getDesktopEnvironment() || 'unknown',
  };
}
