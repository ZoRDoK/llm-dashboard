import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { config } from '../config';
import { ModelUsage } from '../model-usage';
import { Provider } from '../provider';
import type { ProviderAdapter } from '../types';
import { UsageWindow } from '../usage-window';

const FETCH_TIMEOUT_MS = 5_000;
const KEEPALIVE_INTERVAL_MS = 180_000; // 3 minutes
const HTTP_UNAUTHORIZED = 401;
const COOKIE_FILE = 'data/context7-cookies.txt';
const TEAMSPACES_API = 'https://context7.com/api/dashboard/teamspaces';
const STATS_API = 'https://context7.com/api/dashboard/stats';

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

// Cookie state — persisted to disk so it survives server restarts
let storedCookies: string | null = null;
let keepaliveTimer: ReturnType<typeof setTimeout> | null = null;

/* ── Cookie helpers ────────────────────────────────────── */

function loadCookies(): string | null {
  // Prefer persisted file over .env config
  if (existsSync(COOKIE_FILE)) {
    return readFileSync(COOKIE_FILE, 'utf-8').trim() || null;
  }

  return config.context7SessionCookie || null;
}

function saveCookies(cookies: string): void {
  try {
    const dir = COOKIE_FILE.slice(0, COOKIE_FILE.lastIndexOf('/'));
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(COOKIE_FILE, cookies, 'utf-8');
  } catch (err) {
    console.error('Failed to persist cookies:', err);
  }
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
        'user-agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    mergeResponseCookies(response);

    if (response.status === HTTP_UNAUTHORIZED) {
      console.warn('Context7 session expired, showing stale cached data');
    }
  } catch (err) {
    // Network errors are expected during dev — don't spam logs
    if (err instanceof Error && err.name !== 'AbortError') {
      console.error('Context7 keepalive failed:', err.message);
    }
  }
}

function mergeResponseCookies(response: Response): void {
  const setCookies =
    'getSetCookie' in response.headers
      ? (response.headers as unknown as { getSetCookie(): string[] }).getSetCookie()
      : [response.headers.get('set-cookie') ?? ''];

  const valid = setCookies.filter(Boolean);

  if (valid.length > 0) {
    storedCookies = mergeSetCookies(storedCookies ?? '', valid);
    saveCookies(storedCookies);
  }
}

/* ── Adapter ───────────────────────────────────────────── */

export class Context7 implements ProviderAdapter {
  id = 'context7';
  name = 'Context7';

  async fetchUsage(): Promise<Provider> {
    // Lazy-init: load from file / .env on first call
    if (!storedCookies) {
      storedCookies = loadCookies();
    }

    if (!storedCookies) {
      return new Provider(this.id, this.name, 'Not configured', []);
    }

    // Start background keepalive on first usage
    if (!keepaliveTimer) {
      this.startKeepalive();
    }

    const teamspaceId = await this.fetchDefaultTeamspace(storedCookies);
    const stats = await this.fetchStats(storedCookies, teamspaceId);

    const plan = stats.ownerPlan.charAt(0).toUpperCase() + stats.ownerPlan.slice(1);

    const windows: UsageWindow[] = [];

    // Monthly quota: quotaLimit is the cap, creditBalance is credits consumed
    if (stats.quotaLimit != null && stats.quotaLimit > 0) {
      const used = Math.max(0, Math.min(stats.creditBalance, stats.quotaLimit));
      windows.push(UsageWindow.fromCounts('monthly', used, stats.quotaLimit, null));
    }

    // Current month aggregate
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

    return new Provider(this.id, this.name, plan, [ModelUsage.from('Context7', windows)]);
  }

  /** Start background keepalive timer. Idempotent. */
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

  /** Stop background keepalive timer. */
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
        'user-agent': USER_AGENT,
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
        'user-agent': USER_AGENT,
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
