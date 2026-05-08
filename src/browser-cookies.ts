/**
 * Browser-based cookie refresher for Clerk-authenticated sites.
 *
 * Clerk uses HttpOnly `__client` cookies that cannot be extracted from
 * `document.cookie`.  Without the original client token, Clerk's refresh
 * flow creates a new client identity and the dashboard API rejects it.
 *
 * The ONLY reliable way to obtain a fresh session is to connect to the
 * user's actual Chrome via Chrome DevTools Protocol (CDP), where the
 * HttpOnly `__client` cookie already exists.
 *
 * Usage:
 *   Start Chrome with:  google-chrome --remote-debugging-port=9222
 *   Then this module connects to it and extracts fresh cookies.
 */
import { chromium } from '@playwright/test';

const CDP_PORT = 9222;
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
const FETCH_TIMEOUT_MS = 10_000;
const PAGE_WAIT_AFTER_LOAD_MS = 2_000;
const PORT_CHECK_TIMEOUT_MS = 1_000;

interface BrowserCookieResult {
  ok: boolean;
  cookieString: string | null;
  mode: 'cdp' | 'headless' | 'none';
  error?: string;
}

/**
 * Try to obtain fresh cookies for context7.com.
 *
 * Strategy:
 *   1. Try CDP — connect to the user's Chrome (must be started with
 *      `--remote-debugging-port=${CDP_PORT}`).  This is the only method
 *      that yields HttpOnly `__client` cookies.
 *   2. If CDP is unavailable, return null.  The caller should fall back
 *      to cached data.
 */
export async function refreshCookiesViaBrowser(
  _staleCookies: string,
): Promise<BrowserCookieResult> {
  // ── 1. Try CDP ──────────────────────────────────────────
  try {
    const cdpResult = await tryCdp();

    if (cdpResult.ok && cdpResult.cookieString) {
      return cdpResult;
    }

    console.warn('CDP unavailable:', cdpResult.error);
  } catch (err) {
    console.warn('CDP error:', err instanceof Error ? err.message : String(err));
  }

  return { ok: false, cookieString: null, mode: 'none', error: 'No browser available' };
}

/**
 * Connect to the user's Chrome via CDP and extract fresh cookies.
 */
async function tryCdp(): Promise<BrowserCookieResult> {
  // Check if Chrome is listening on the debug port
  const alive = await checkPort(CDP_PORT);

  if (!alive) {
    return {
      ok: false,
      cookieString: null,
      mode: 'cdp',
      error: `Chrome not found on port ${CDP_PORT}. Start Chrome with: google-chrome --remote-debugging-port=${CDP_PORT}`,
    };
  }

  const browser = await chromium.connectOverCDP(CDP_URL);

  try {
    const allContexts = browser.contexts();

    if (allContexts.length === 0) {
      return { ok: false, cookieString: null, mode: 'cdp', error: 'No browser contexts found' };
    }

    // Use the default context (which has the user's session)
    const context = allContexts[0];
    const pages = context.pages();

    // Navigate to context7.com/dashboard in an existing or new tab
    let page = pages.find((p) => p.url().includes('context7.com'));

    if (!page) {
      page = await context.newPage();
    }

    await page.goto('https://context7.com/dashboard', {
      waitUntil: 'networkidle',
      timeout: FETCH_TIMEOUT_MS,
    });

    await page.waitForTimeout(PAGE_WAIT_AFTER_LOAD_MS);

    // Extract ALL cookies including HttpOnly
    const allCookies = await context.cookies();
    const context7Cookies = allCookies.filter(
      (c) => c.domain.includes('context7.com') || c.domain.includes('clerk.context7.com'),
    );

    const cookieString = context7Cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    const hasSession = context7Cookies.some((c) => c.name.startsWith('__session'));

    if (!hasSession) {
      return {
        ok: false,
        cookieString,
        mode: 'cdp',
        error: 'No session cookies found — are you logged into context7.com?',
      };
    }

    return { ok: true, cookieString, mode: 'cdp' };
  } finally {
    // Don't close the browser — it's the user's Chrome
    // Just detach from it
    await browser.close();
  }
}

/** Quick TCP check to see if anything is listening on the given port. */
async function checkPort(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(PORT_CHECK_TIMEOUT_MS),
    });

    return response.ok;
  } catch {
    return false;
  }
}
