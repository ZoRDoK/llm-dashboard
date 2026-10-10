import { refreshCookiesViaBrowser } from '../browser-cookies.js';
import { config } from '../config.js';
import { CHROME_USER_AGENT, FETCH_TIMEOUT_MS } from '../constants.js';
import { readDataFile, writeDataFile } from '../data-file.js';
import { fetchRaw } from '../fetch-utils.js';
import { createLogger } from '../logger.js';
import { Provider } from '../provider.js';
import { msToIso } from '../time-utils.js';
import type { ProviderAdapter } from '../types.js';
import { UsageWindow } from '../usage-window.js';

const log = createLogger('adapter:commandcode');

const SESSION_URL = 'https://api.commandcode.ai/auth/get-session';
const CREDITS_URL = 'https://api.commandcode.ai/internal/billing/credits';
const SUMMARY_URL = 'https://api.commandcode.ai/internal/usage/summary';
const SUBSCRIPTIONS_URL = 'https://api.commandcode.ai/internal/billing/subscriptions';
const COOKIE_NAME = '__Secure-commandcode_prod_.session_token';
const TOKEN_FILE = 'data/commandcode-token.txt';
const TOKEN_FILE_LABEL = 'Command Code token';
const REFERER = 'https://commandcode.ai/';
const ROUND_SCALE = 100;
const HTTP_UNAUTHORIZED = 401;
const SESSION_EXPIRED_ERROR = 'Command Code session expired, re-authenticate required';
const CDP_HINT = 'google-chrome --remote-debugging-port=9222';

/** Round a number to 2 decimal places (for dollar amounts). */
const round2 = (n: number): number => Math.round(n * ROUND_SCALE) / ROUND_SCALE;

// Token state — persisted to disk so the sliding session survives server restarts
let storedToken: string | null = null;

/* ── Token helpers ─────────────────────────────────────── */

function loadToken(): string | null {
  return readDataFile(TOKEN_FILE, config.COMMANDCODE_SESSION_TOKEN);
}

function saveToken(value: string): void {
  writeDataFile(TOKEN_FILE, value, TOKEN_FILE_LABEL);
}

/** Extract a renewed session_token value from Set-Cookie headers, if present. */
function extractTokenFromSetCookies(setCookies: string[]): string | null {
  const prefix = `${COOKIE_NAME}=`;

  for (const header of setCookies) {
    if (header.startsWith(prefix)) {
      const value = header.slice(prefix.length);
      const semi = value.indexOf(';');

      return semi === -1 ? value : value.slice(0, semi);
    }
  }

  return null;
}

/** Find the COOKIE_NAME value inside a full `name=value; name2=value2` cookie string. */
function parseTokenFromCookieString(cookieString: string): string | null {
  const prefix = `${COOKIE_NAME}=`;

  for (const part of cookieString.split(';')) {
    const trimmed = part.trim();

    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }

  return null;
}

/** Build the auth cookie header from the current token (only called when set). */
function cookieHeader(): string {
  return `${COOKIE_NAME}=${storedToken ?? ''}`;
}

/* ── Types ─────────────────────────────────────────────── */

interface WindowLimit {
  used: number;
  cap: number;
  resetAt: number;
  exceeded?: boolean;
}

interface WindowLimits {
  limited?: boolean;
  fiveHour?: WindowLimit;
  weekly?: WindowLimit;
}

interface CreditsData {
  monthlyCredits?: number;
}

interface CreditsResponse {
  credits?: CreditsData;
  windowLimits?: WindowLimits;
}

interface SummaryResponse {
  totalMonthlyCredits?: number;
}

interface SubscriptionsData {
  currentPeriodEnd?: string;
}

interface SubscriptionsResponse {
  success?: boolean;
  data?: SubscriptionsData;
}

interface UsageData {
  credits: CreditsResponse;
  summary: SummaryResponse;
  subscription: SubscriptionsResponse | null;
}

/* ── Adapter ───────────────────────────────────────────── */

export class CommandCode implements ProviderAdapter {
  readonly id = 'commandcode';
  readonly name = 'Command Code';

  async fetchUsage(): Promise<Provider> {
    if (storedToken == null) {
      storedToken = loadToken();
    }

    // Bootstrap via CDP when no persisted/env token is available
    if (storedToken == null) {
      await this.bootstrapViaBrowser();
    }

    if (storedToken == null) {
      return new Provider(this.id, this.name, 'Not configured', []);
    }

    // Renew the sliding session; throws only when the session is truly dead.
    await this.touchSession();

    const { credits, summary, subscription } = await this.fetchUsageData();

    const windows = this.buildWindows(credits, summary, subscription);

    return new Provider(this.id, this.name, 'Command Code', [{ modelName: 'Credits', windows }]);
  }

  private async bootstrapViaBrowser(): Promise<void> {
    const result = await refreshCookiesViaBrowser({
      domain: 'commandcode.ai',
      cookieName: COOKIE_NAME,
      exactName: true,
    });

    if (!(result.ok && result.cookieString)) {
      return;
    }

    const token = parseTokenFromCookieString(result.cookieString);

    if (token) {
      storedToken = token;
      saveToken(storedToken);
      log.info({ mode: result.mode }, 'Command Code session bootstrapped');
    }
  }

  /**
   * Call get-session to keep the better-auth sliding session alive. A successful
   * response refreshes `session_data` (short Max-Age, ignored) and, once the
   * session passes better-auth's updateAge, also issues a NEW session_token via
   * Set-Cookie — that renewal is captured and persisted.
   */
  private async touchSession(): Promise<void> {
    const requestHeaders = {
      cookie: cookieHeader(),
      'user-agent': CHROME_USER_AGENT,
      accept: 'application/json',
      referer: REFERER,
    };
    const response = await fetchRaw(SESSION_URL, { headers: requestHeaders }, FETCH_TIMEOUT_MS);

    const headers = response.headers as Headers & { getSetCookie?(): string[] };
    const setCookies = (headers.getSetCookie?.() ?? [headers.get('set-cookie') ?? '']).filter(
      Boolean,
    );

    if (response.status === HTTP_UNAUTHORIZED) {
      if (await this.refreshViaBrowser()) {
        return;
      }

      throw new Error(SESSION_EXPIRED_ERROR);
    }

    // Capture the sliding renewal whenever the backend issues a fresh token.
    const fresh = extractTokenFromSetCookies(setCookies);

    if (fresh) {
      storedToken = fresh;
      saveToken(storedToken);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  }

  /** Attempt to recover a dead session by extracting a fresh token from Chrome via CDP. */
  private async refreshViaBrowser(): Promise<boolean> {
    const result = await refreshCookiesViaBrowser({
      domain: 'commandcode.ai',
      cookieName: COOKIE_NAME,
      exactName: true,
    });

    if (result.ok && result.cookieString) {
      const token = parseTokenFromCookieString(result.cookieString);

      if (token) {
        storedToken = token;
        saveToken(storedToken);
        log.info({ mode: result.mode }, 'Command Code session refreshed');

        return true;
      }
    }

    if (result.error?.includes('Chrome not found')) {
      log.warn(`CDP unavailable — using cached data. Start Chrome with: ${CDP_HINT}`);
    }

    return false;
  }

  /** Fetch credits + summary (fatal) and subscription (non-fatal), retrying once via CDP on a 401. */
  private async fetchUsageData(): Promise<UsageData> {
    try {
      return await this.fetchUsageBundle();
    } catch (err) {
      if (!(err instanceof Error && err.message === SESSION_EXPIRED_ERROR)) {
        throw err;
      }

      if (!(await this.refreshViaBrowser())) {
        throw err;
      }

      return await this.fetchUsageBundle();
    }
  }

  /** Parallel fetch of credits + summary (fatal) and subscription (non-fatal). */
  private async fetchUsageBundle(): Promise<UsageData> {
    const [credits, summary, subscription] = await Promise.all([
      this.fetchJson<CreditsResponse>(CREDITS_URL),
      this.fetchJson<SummaryResponse>(SUMMARY_URL),
      this.fetchSubscription(),
    ]);

    return { credits, summary, subscription };
  }

  /** Fetch the billing subscription (monthly reset date) — non-fatal; yields null on any failure. */
  private async fetchSubscription(): Promise<SubscriptionsResponse | null> {
    try {
      return await this.fetchJson<SubscriptionsResponse>(SUBSCRIPTIONS_URL);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err : new Error(String(err)) },
        'Command Code subscription fetch failed',
      );

      return null;
    }
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const requestHeaders = {
      cookie: cookieHeader(),
      'user-agent': CHROME_USER_AGENT,
      accept: 'application/json',
      referer: REFERER,
    };
    const response = await fetchRaw(url, { headers: requestHeaders }, FETCH_TIMEOUT_MS);

    if (response.status === HTTP_UNAUTHORIZED) {
      throw new Error(SESSION_EXPIRED_ERROR);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return (await response.json()) as T;
  }

  private buildWindows(
    credits: CreditsResponse,
    summary: SummaryResponse,
    subscription: SubscriptionsResponse | null,
  ): UsageWindow[] {
    const windows: UsageWindow[] = [];
    const limits = credits.windowLimits;

    if (limits?.fiveHour && limits.fiveHour.cap > 0) {
      windows.push(this.buildLimitWindow('5h', limits.fiveHour));
    }

    if (limits?.weekly && limits.weekly.cap > 0) {
      windows.push(this.buildLimitWindow('weekly', limits.weekly));
    }

    const monthlyUsed = summary.totalMonthlyCredits ?? 0;
    const monthlyRemaining = credits.credits?.monthlyCredits ?? 0;
    const monthlyCap = monthlyUsed + monthlyRemaining;
    const monthlyResetAt = subscription?.data?.currentPeriodEnd ?? null;

    if (monthlyCap > 0) {
      windows.push(
        UsageWindow.fromCounts(
          'monthly',
          monthlyUsed,
          monthlyCap,
          monthlyResetAt,
          `$${round2(monthlyRemaining)} left`,
        ),
      );
    }

    return windows;
  }

  private buildLimitWindow(label: string, limit: WindowLimit): UsageWindow {
    // fromCounts throws when used > total, so clamp to cap (caps percent at 100).
    const used = Math.min(limit.used, limit.cap);
    const resetAt = limit.resetAt > 0 ? msToIso(limit.resetAt) : null;

    return UsageWindow.fromCounts(
      label,
      used,
      limit.cap,
      resetAt,
      `$${round2(used)} / $${round2(limit.cap)}`,
    );
  }
}
