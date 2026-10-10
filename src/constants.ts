export const MS_PER_SECOND = 1_000;
export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;
export const DAYS_PER_WEEK = 7;
export const DAYS_PER_MONTH = 30;

/**
 * Global fetch timeout. 10s because slow endpoints (firecrawl credit-usage can
 * exceed 5s) must not abort into stale-serving; the 60s background refresh
 * cadence tolerates a longer per-fetch bound.
 */
export const FETCH_TIMEOUT_MS = 10_000;

/** Chrome UA used by scrapers so dashboard endpoints treat us as a real browser. */
export const CHROME_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
