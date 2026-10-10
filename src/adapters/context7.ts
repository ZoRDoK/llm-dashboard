import { refreshCookiesViaBrowser } from '../browser-cookies.js';
import { config } from '../config.js';
import { CHROME_USER_AGENT, FETCH_TIMEOUT_MS } from '../constants.js';
import { readDataFile, writeDataFile } from '../data-file.js';
import { createLogger } from '../logger.js';
import { Provider } from '../provider.js';
import type { ProviderAdapter } from '../types.js';
import { UsageWindow } from '../usage-window.js';

const log = createLogger('adapter:context7');

const KEEPALIVE_INTERVAL_MS = 180_000; // 3 minutes
const HTTP_UNAUTHORIZED = 401;
const COOKIE_FILE = 'data/context7-cookies.txt';
const COOKIE_FILE_LABEL = 'cookies';
const TEAMSPACES_API = 'https://context7.com/api/dashboard/teamspaces';
const STATS_API = 'https://context7.com/api/dashboard/stats';

const NOT_CONFIGURED_MSG =
  'Start Chrome with --remote-debugging-port=9222 and log into context7.com, or set CONTEXT7_SESSION_COOKIE';

// Cookie state — persisted to disk so it survives server restarts
let storedCookies: string | null = null;
let keepaliveTimer: ReturnType<typeof setTimeout> | null = null;

/* ── Cookie helpers ────────────────────────────────────── */

function loadCookies(): string | null {
  return readDataFile(COOKIE_FILE, config.CONTEXT7_SESSION_COOKIE);
}

function saveCookies(cookies: string): void {
  writeDataFile(COOKIE_FILE, cookies, COOKIE_FILE_LABEL);
}

/** Parse a Set-Cookie header value into name=value pair, dropping attributes. */
function parseSetCookieValue(setCookie: string): string {
  const semi = setCookie.indexOf(';');

  return semi === -1 ? setCookie : setCookie.slice(0, semi);
}

/** Replace individual cookies in base string with values from Set-Cookie headers. */
function mergeSetCookies(base: string, setCookies: string[]): string {
  if (setCookies.length === 0) {
    return base;
  }

  const parsed = setCookies.map(parseSetCookieValue);
  const parts = base.split('; ');

  for (const fresh of parsed) {
    const [name] = fresh.split('=');
    const idx = parts.findIndex((p) => p.startsWith(`${name}=`) || p === name);

    if (idx === -1) {
      parts.push(fresh);
    } else {
      parts[idx] = fresh;
    }
  }

  return parts.join('; ');
}

/* ── Types ─────────────────────────────────────────────── */

interface Teamspace {
  id: string;
  name: string;
}

interface StatsResponse {
  success: boolean;
  data: {
    dailyStats: DailyStat[];
    quotaLimit: number | null;
    ownerPlan: string;
    creditBalance: number;
  };
}

interface DailyStat {
  date: string;
  parse_tokens: number;
  search_requests: number;
  fetch_docs_requests: number;
  parse_tokens_cost: number;
  member_cost: number;
  api_usage_cost: number;
  member_count: number;
}

/* ── Keepalive ─────────────────────────────────────────── */

/**
 * Periodically fetch a lightweight endpoint to keep the Clerk session alive.
 * Each response sends Set-Cookie headers that refresh session cookies.
 */
async function keepalive(): Promise<void> {
  if (!storedCookies) {
    return;
  }

  try {
    const response = await fetch(TEAMSPACES_API, {
      headers: {
        cookie: storedCookies,
        'user-agent': CHROME_USER_AGENT,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    mergeResponseCookies(response);

    if (response.status === HTTP_UNAUTHORIZED) {
      log.warn('Context7 session expired, trying browser refresh via CDP');

      const result = await refreshCookiesViaBrowser();

      if (result.ok && result.cookieString) {
        storedCookies = result.cookieString;
        saveCookies(storedCookies);
        log.info({ mode: result.mode }, 'Context7 session refreshed');
      } else if (result.error?.includes('Chrome not found')) {
        log.warn(
          'CDP unavailable — using cached data. Start Chrome with: google-chrome --remote-debugging-port=9222',
        );
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name !== 'AbortError') {
      log.error({ err }, 'Context7 keepalive failed');
    }
  }
}

function mergeResponseCookies(response: Response): void {
  const headers = response.headers as Headers & { getSetCookie?(): string[] };
  const setCookies = headers.getSetCookie?.() ?? [headers.get('set-cookie') ?? ''];

  const valid = setCookies.filter(Boolean);

  if (valid.length > 0) {
    storedCookies = mergeSetCookies(storedCookies ?? '', valid);
    saveCookies(storedCookies);
  }
}

/* ── Adapter ───────────────────────────────────────────── */

export class Context7 implements ProviderAdapter {
  readonly id = 'context7';
  readonly name = 'Context7';

  async fetchUsage(): Promise<Provider> {
    if (!storedCookies) {
      storedCookies = loadCookies();
    }

    // Bootstrap via CDP when no persisted/env cookie is available
    if (!storedCookies) {
      const cdpResult = await refreshCookiesViaBrowser();

      if (cdpResult.ok && cdpResult.cookieString) {
        storedCookies = cdpResult.cookieString;
        saveCookies(storedCookies);
        log.info({ mode: cdpResult.mode }, 'Context7 session bootstrapped');
      }
    }

    if (!storedCookies) {
      return Provider.notConfigured(this.id, this.name, NOT_CONFIGURED_MSG);
    }

    if (!keepaliveTimer) {
      this.startKeepalive();
    }

    const teamspaceId = await this.fetchDefaultTeamspace(storedCookies);
    const stats = await this.fetchStats(storedCookies, teamspaceId);

    const plan = stats.ownerPlan.charAt(0).toUpperCase() + stats.ownerPlan.slice(1);

    const windows: UsageWindow[] = [];

    if (typeof stats.quotaLimit === 'number' && stats.quotaLimit > 0) {
      const used = Math.max(0, Math.min(stats.creditBalance, stats.quotaLimit));

      windows.push(UsageWindow.fromCounts('monthly', used, stats.quotaLimit, null));
    }

    const currentMonth = this.currentMonthPrefix();
    const agg = stats.dailyStats
      .filter((d) => d.date.startsWith(currentMonth))
      .reduce(
        (acc, d) => ({
          parseTokens: acc.parseTokens + d.parse_tokens,
          searchRequests: acc.searchRequests + d.search_requests,
          fetchDocsRequests: acc.fetchDocsRequests + d.fetch_docs_requests,
        }),
        { parseTokens: 0, searchRequests: 0, fetchDocsRequests: 0 },
      );

    if (agg.parseTokens > 0) {
      windows.push(UsageWindow.fromCounts('parse_tokens', agg.parseTokens, agg.parseTokens, null));
    }

    if (agg.searchRequests > 0) {
      windows.push(
        UsageWindow.fromCounts('searches', agg.searchRequests, agg.searchRequests, null),
      );
    }

    if (agg.fetchDocsRequests > 0) {
      windows.push(
        UsageWindow.fromCounts('fetches', agg.fetchDocsRequests, agg.fetchDocsRequests, null),
      );
    }

    return new Provider(this.id, this.name, plan, [{ modelName: 'Context7', windows }]);
  }

  startKeepalive(): void {
    if (keepaliveTimer) {
      return;
    }

    keepaliveTimer = setTimeout(() => {
      keepaliveTimer = null;
      keepalive()
        .catch(() => {
          /* logged inside keepalive */
        })
        .finally(() => {
          this.startKeepalive();
        });
    }, KEEPALIVE_INTERVAL_MS);
  }

  stopKeepalive(): void {
    if (keepaliveTimer) {
      clearTimeout(keepaliveTimer);
      keepaliveTimer = null;
    }
  }

  private async fetchDefaultTeamspace(cookies: string): Promise<string> {
    const response = await fetch(TEAMSPACES_API, {
      headers: {
        cookie: cookies,
        'user-agent': CHROME_USER_AGENT,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching teamspaces`);
    }

    mergeResponseCookies(response);

    const raw = (await response.json()) as { success: boolean; data: Teamspace[] };

    if (!raw.data?.length) {
      throw new Error('No teamspaces found');
    }

    return raw.data[0].id;
  }

  private async fetchStats(cookies: string, teamspaceId: string): Promise<StatsResponse['data']> {
    const url = `${STATS_API}/${encodeURIComponent(teamspaceId)}`;

    const response = await fetch(url, {
      headers: {
        cookie: cookies,
        'user-agent': CHROME_USER_AGENT,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching stats`);
    }

    mergeResponseCookies(response);

    const raw = (await response.json()) as StatsResponse;

    return raw.data;
  }

  private currentMonthPrefix(): string {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');

    return `${y}-${m}`;
  }
}
