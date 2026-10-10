import {
  DAYS_PER_WEEK,
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  MS_PER_SECOND,
} from './constants.js';

const UNIX_SECONDS_TO_MS = MS_PER_SECOND;

/** Parse "Resets in 5 days 3 hours" text into an ISO timestamp. */
export function parseResetIn(text: string | null): string | null {
  if (!text) {
    return null;
  }

  const clean = text.replace(/[~≈]/g, '').trim();

  // 1. Extract all time components
  const d = clean.match(/(\d+)\s*d(?:ays?)?/i);
  const h = clean.match(/(\d+)\s*h(?:ours?)?/i);
  const m = clean.match(/(\d+)\s*m(?:in(?:utes?)?)?/i);

  // 2. Accumulate milliseconds
  let ms = 0;
  let matches = 0;

  if (d) {
    ms += Number.parseInt(d[1], 10) * MS_PER_DAY;
    matches++;
  }

  if (h) {
    ms += Number.parseInt(h[1], 10) * MS_PER_HOUR;
    matches++;
  }

  if (m) {
    ms += Number.parseInt(m[1], 10) * MS_PER_MINUTE;
    matches++;
  }

  if (matches === 0) {
    throw new Error(`Could not parse reset time: ${text}`);
  }

  return new Date(Date.now() + ms).toISOString();
}

/** Convert a unix epoch timestamp (seconds) to ISO string. */
export function epochToIso(ts: number): string {
  return new Date(ts * UNIX_SECONDS_TO_MS).toISOString();
}

/** Convert a millisecond timestamp to ISO string. */
export function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Format elapsed time since a timestamp as a short label
 * (e.g. "5m", "2h", "3d", or "now"). Returns '' for null.
 */
export function formatElapsed(ts: number | null): string {
  if (ts == null) {
    return '';
  }

  const elapsed = Date.now() - ts;

  if (elapsed >= MS_PER_DAY) {
    return `${Math.floor(elapsed / MS_PER_DAY)}d`;
  }

  if (elapsed >= MS_PER_HOUR) {
    return `${Math.floor(elapsed / MS_PER_HOUR)}h`;
  }

  if (elapsed >= MS_PER_MINUTE) {
    return `${Math.floor(elapsed / MS_PER_MINUTE)}m`;
  }

  return 'now';
}

/**
 * Return the Monday that starts the ISO week containing `now`, formatted as
 * YYYY-MM-DD. ISO weeks start on Monday; getUTCDay() returns Sunday=0, so the
 * offset from the current day back to Monday is (day + 6) % 7.
 */
export function weekStartKey(now: Date): string {
  const day = now.getUTCDay();
  const offset = (day + (DAYS_PER_WEEK - 1)) % DAYS_PER_WEEK;
  const monday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset);

  return new Date(monday).toISOString().slice(0, 10);
}

/**
 * Return the ISO string of the next Monday 00:00:00 UTC — the exclusive end
 * of the ISO week containing `now`.
 */
export function weekEndIso(now: Date): string {
  const day = now.getUTCDay();
  const offset = (day + (DAYS_PER_WEEK - 1)) % DAYS_PER_WEEK;
  const monday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset);
  const nextMonday = monday + DAYS_PER_WEEK * MS_PER_DAY;

  return new Date(nextMonday).toISOString();
}
