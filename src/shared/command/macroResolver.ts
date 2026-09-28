import { DateTime } from 'luxon';

/**
 * Resolves the macros and Display tags in a command string segment.
 *
 * Runs at dispatch rather than when commands are parsed, since a cached command string
 * would otherwise carry a stale value. Applied per segment, after the string has been split
 * on `|`, so a substituted value containing a `|` cannot corrupt the segment boundaries.
 */

/** Values a segment resolves against. Getters, so each resolution reads the current state. */
export type MacroContext = {
  getTags: () => Record<string, string>;
  getLocation: () => { latitude: number | null; longitude: number | null };
};

/**
 * Matches `[[tagName]]`, or `[MACRO_NAME]` with an optional arithmetic modifier.
 *
 * One left-to-right scan with the tag form first, so tags resolve before macros and a
 * substituted value is never re-scanned. Upper case only, so `[epoch]` stays literal text.
 * The modifier is strict: anything it rejects, such as `[EPOCH@99:99]` or `[EPOCH+60@08:00]`,
 * fails to match as a macro at all and is left literal.
 */
const PLACEHOLDER = String.raw`\[\[(\w+)\]\]|\[([A-Z_]+)((?:[+-]\d+)|(?:@(?:[01]\d|2[0-3]):[0-5]\d))?\]`;

// Global, so every placeholder in a segment is replaced rather than only the first.
const PATTERN = new RegExp(PLACEHOLDER, 'g');

// The same placeholder, anchored, to test whether a segment opens with one.
const LEADING_PLACEHOLDER = new RegExp(`^\\s*(?:${PLACEHOLDER})`);

/**
 * Bracketed text opening with a macro name that did not resolve, such as `[EPOCH@8:00]`
 * missing its leading zero. Without this a typo is silent. Only the macro names match, so
 * ordinary brackets in an RS232 or shell command are left alone.
 */
const MALFORMED_MACRO_PATTERN = /\[(?:EPOCH|UNIX_TIMESTAMP|TIMESTAMP|LAT|LNG)(?![A-Z_])[^\]]*\]/g;

// A segment that opens with a URL scheme, such as `http://device/api`.
const URL_SEGMENT = /^[a-z][a-z0-9+.-]*:\/\//i;

// A segment that opens a JSON object or array.
const JSON_SEGMENT = /^\s*[{[]/;

/**
 * How many JSON strings enclose the placeholder at `offset`.
 *
 * An HTTP command's body is a JSON string inside the request config, so a value substituted
 * there sits two deep. Reading the outer document consumes one round of escaping, so each
 * level needs a round of its own.
 */
function jsonDepthAt(segment: string, offset: number): number {
  const preceding = segment.slice(0, offset);

  // Literal quotes inside a JSON string are escaped, so the nearest one back opened it.
  const openingQuote = preceding.lastIndexOf('"');

  if (openingQuote === -1) {
    return 1;
  }

  let backslashes = 0;
  for (let i = openingQuote - 1; i >= 0 && preceding[i] === '\\'; i--) {
    backslashes++;
  }

  // That quote is escaped once per level above it, doubling each time: `"`, `\"`, `\\\"`.
  return Math.round(Math.log2(backslashes + 1)) + 1;
}

// Escapes a value for `depth` levels of enclosing JSON string.
function jsonEscape(value: string, depth: number): string {
  let escaped = value;

  for (let level = 0; level < depth; level++) {
    // stringify escapes and quotes the value; the document supplies its own quotes.
    escaped = JSON.stringify(escaped).slice(1, -1);
  }

  return escaped;
}

/**
 * Picks how to escape substituted values, from the shape of the segment. A tag value is
 * typed by hand: an unescaped `&` truncates a URL, an unescaped `"` breaks a JSON document.
 *
 * `[` opens a JSON array but also opens a macro, so a leading placeholder rules out an array.
 */
function escaperFor(segment: string): (value: string, offset: number) => string {
  if (URL_SEGMENT.test(segment)) {
    return encodeURIComponent;
  }

  if (JSON_SEGMENT.test(segment) && !LEADING_PLACEHOLDER.test(segment)) {
    return (value: string, offset: number) => jsonEscape(value, jsonDepthAt(segment, offset));
  }

  return (value: string) => value;
}

/**
 * Resolves one Display tag. Unlike the Webpage widget, which substitutes an empty string for
 * an unmatched tag, this throws, so a command is never dispatched carrying a value the
 * target device would accept as valid but act on nonsensically.
 *
 * @throws If the tag is absent, or present with no value
 */
function resolveTag(tagName: string, tags: Record<string, string>): string {
  // Tag names are matched exactly, with no trimming or case folding.
  const value = tags[tagName];

  if (value === undefined) {
    throw new Error(`[MacroResolver] Unresolvable tag [[${tagName}]]: not set on this Display`);
  }

  if (value === '') {
    throw new Error(`[MacroResolver] Unresolvable tag [[${tagName}]]: set, but has no value`);
  }

  return value;
}

/**
 * Resolves one macro name. Returns `undefined` for a name outside the vocabulary, leaving the
 * text literal, since brackets occur legitimately in shell and RS232 command strings. A name
 * that is in the vocabulary but has no value available throws instead.
 *
 * @throws If a recognised macro has no value available
 */
function resolveMacro(macroName: string, modifier: string | undefined, context: MacroContext): string | undefined {
  // Arithmetic is defined for EPOCH alone, so a modifier on any other macro leaves the
  // whole thing literal.
  if (modifier && macroName !== 'EPOCH') {
    return undefined;
  }

  switch (macroName) {
    case 'EPOCH':
      return String(resolveEpoch(modifier));

    case 'UNIX_TIMESTAMP':
      return String(Date.now());

    case 'TIMESTAMP':
      // Local time with its UTC offset, rather than a bare UTC instant: a Display's
      // commands are read against the site's wall clock.
      return DateTime.now().toISO() ?? '';

    case 'LAT':
      return String(requireCoordinate(context.getLocation().latitude, 'LAT'));

    case 'LNG':
      return String(requireCoordinate(context.getLocation().longitude, 'LNG'));

    default:
      return undefined;
  }
}

/**
 * Resolves `[EPOCH]` and its arithmetic forms to a Unix timestamp in seconds.
 *
 * An offset is plain addition. An anchor resolves to the next occurrence of a local time,
 * which stays correct across a daylight saving change because it is evaluated against the
 * wall clock rather than by adding a fixed interval. Luxon takes the first occurrence of a
 * repeated time, as required, but overshoots one that never happened, which
 * `firstInstantAfterGap()` corrects.
 */
function resolveEpoch(modifier: string | undefined): number {
  const nowInSeconds = Math.floor(Date.now() / 1000);

  if (!modifier) {
    return nowInSeconds;
  }

  if (modifier.startsWith('@')) {
    const [hour, minute] = modifier.slice(1).split(':').map(Number);
    const now = DateTime.now();

    let anchor = now.set({ hour, minute, second: 0, millisecond: 0 });

    // The anchor is always strictly in the future, so a time already reached today
    // resolves to tomorrow's occurrence. Adding a day rather than 86400 seconds keeps the
    // wall-clock time intact across a transition.
    if (anchor <= now) {
      anchor = anchor.plus({ days: 1 });
    }

    // A time luxon could not honour did not exist on that date, so take the instant the
    // clocks moved rather than luxon's overshoot.
    if (anchor.hour !== hour || anchor.minute !== minute) {
      return firstInstantAfterGap(anchor);
    }

    return Math.floor(anchor.toSeconds());
  }

  return nowInSeconds + Number(modifier);
}

/**
 * First instant that exists after a daylight saving gap, in seconds. Halves the day to find
 * the minute the UTC offset changes, rather than assuming the transition falls on the hour,
 * which is not true in every zone.
 *
 * @param shifted The overshot time luxon returned, used only for the date it falls on
 */
function firstInstantAfterGap(shifted: DateTime): number {
  const dayStart = shifted.startOf('day');
  const offsetBeforeTransition = dayStart.offset;

  let before = dayStart.toMillis();
  let after = dayStart.plus({ days: 1 }).toMillis();

  while (after - before > 60000) {
    const midpoint = Math.floor((before + after) / 2);

    if (DateTime.fromMillis(midpoint).offset === offsetBeforeTransition) {
      before = midpoint;
    } else {
      after = midpoint;
    }
  }

  return Math.floor(after / 1000);
}

/**
 * Asserts a coordinate is available. Zero is a legitimate coordinate; only a missing fix is
 * unresolvable.
 *
 * @throws If no position fix has been acquired yet
 */
function requireCoordinate(value: number | null, macroName: string): number {
  if (value === null || value === undefined || !isFinite(value)) {
    throw new Error(`[MacroResolver] Unresolvable macro [${macroName}]: no position fix available`);
  }

  return value;
}

/**
 * Resolves the `[[tag]]` and `[MACRO]` references in a command string segment.
 *
 * @param segment A single command string segment
 * @param context Supplies the Display's tags and current position
 * @throws If a referenced tag or a recognised macro cannot be resolved
 */
export function resolveSegment(segment: string, context: MacroContext): string {
  if (!segment) {
    return segment;
  }

  const tags = context.getTags();

  const escape = escaperFor(segment);

  const substitute = (
    match: string,
    tagName: string | undefined,
    macroName: string | undefined,
    modifier: string | undefined,
    offset: number
  ): string => {
    if (tagName !== undefined) {
      return escape(resolveTag(tagName, tags), offset);
    }

    const resolved = resolveMacro(macroName as string, modifier, context);

    // An unrecognised name is left untouched, and not escaped: nothing was substituted.
    if (resolved === undefined) {
      return match;
    }

    return escape(resolved, offset);
  };

  const resolved = segment.replace(PATTERN, substitute);

  // Anything still carrying a macro name was not valid syntax, since every valid one has
  // been substituted by now.
  const malformed = resolved.match(MALFORMED_MACRO_PATTERN);

  if (malformed) {
    console.error('[MacroResolver] Invalid macro syntax, sent as literal text', {
      macros: malformed,
    });
  }

  return resolved;
}
