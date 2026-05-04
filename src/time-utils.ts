const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_MIN = 60_000;
const UNIX_SECONDS_TO_MS = 1_000;

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
    ms += Number.parseInt(m[1], 10) * MS_PER_MIN;
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
