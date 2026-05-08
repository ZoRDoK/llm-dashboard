import { config } from '../config';
import { ModelUsage } from '../model-usage';
import { Provider } from '../provider';
import type { ProviderAdapter } from '../types';
import { UsageWindow } from '../usage-window';

const FETCH_TIMEOUT_MS = 5_000;
const TEAMSPACES_API = 'https://context7.com/api/dashboard/teamspaces';
const STATS_API = 'https://context7.com/api/dashboard/stats';

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

// In-memory cookie store — refreshed on each API call via Set-Cookie
let storedSessionCookie: string | null = null;

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

export class Context7 implements ProviderAdapter {
  id = 'context7';
  name = 'Context7';

  async fetchUsage(): Promise<Provider> {
    const initialCookie = storedSessionCookie ?? config.context7SessionCookie;

    if (!initialCookie) {
      return new Provider(this.id, this.name, 'Not configured', []);
    }

    const { cookie, teamspaceId } = await this.fetchDefaultTeamspace(initialCookie);
    const stats = await this.fetchStats(cookie, teamspaceId);

    const plan = stats.ownerPlan.charAt(0).toUpperCase() + stats.ownerPlan.slice(1);

    const windows: UsageWindow[] = [];

    // Monthly quota: quotaLimit is the cap, creditBalance is remaining
    if (stats.quotaLimit != null && stats.quotaLimit > 0) {
      const used = stats.quotaLimit - stats.creditBalance;
      windows.push(UsageWindow.fromCounts('monthly', Math.max(0, used), stats.quotaLimit, null));
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

  private async fetchDefaultTeamspace(
    sessionCookie: string,
  ): Promise<{ cookie: string; teamspaceId: string }> {
    const response = await fetch(TEAMSPACES_API, {
      headers: {
        cookie: sessionCookie,
        'user-agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching teamspaces`);
    }

    // Update stored cookie from Set-Cookie (session refreshes on each request)
    this.updateStoredCookie(response);

    const raw = (await response.json()) as { success: boolean; data: Teamspace[] };

    if (!raw.data?.length) {
      throw new Error('No teamspaces found');
    }

    return {
      cookie: storedSessionCookie ?? sessionCookie,
      teamspaceId: raw.data[0].id,
    };
  }

  private async fetchStats(
    sessionCookie: string,
    teamspaceId: string,
  ): Promise<StatsResponse['data']> {
    const url = `${STATS_API}/${encodeURIComponent(teamspaceId)}`;

    const response = await fetch(url, {
      headers: {
        cookie: sessionCookie,
        'user-agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching stats`);
    }

    this.updateStoredCookie(response);

    const raw = (await response.json()) as StatsResponse;

    return raw.data;
  }

  private updateStoredCookie(response: Response): void {
    // Node.js 20+ supports getSetCookie() which returns all Set-Cookie headers.
    // Fallback to get('set-cookie') which may return comma-joined string.
    const cookies =
      'getSetCookie' in response.headers
        ? (response.headers as unknown as { getSetCookie(): string[] }).getSetCookie()
        : [response.headers.get('set-cookie') ?? ''];

    const valid = cookies.filter(Boolean);

    if (valid.length > 0) {
      storedSessionCookie = valid.join('; ');
    }
  }

  private currentMonthPrefix(): string {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');

    return `${y}-${m}`;
  }
}
