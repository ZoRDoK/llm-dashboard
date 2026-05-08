import { config } from '../config';
import { ModelUsage } from '../model-usage';
import { Provider } from '../provider';
import type { ProviderAdapter } from '../types';
import { UsageWindow } from '../usage-window';

const FETCH_TIMEOUT_MS = 5_000;
const TEAMSPACE_API = 'https://context7.com/api/dashboard/teamspaces';
const TEAMSPACE_USAGE_API = 'https://context7.com/api/dashboard/teamspace';

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

interface TeamspaceUsage {
  dailyStats: DailyStat[];
  quotaLimit: number | null;
  ownerPlan: string;
  creditBalance: number;
}

interface DailyStat {
  date: string;
  parse_tokens: number;
  search_requests: number;
  fetch_docs_requests: number;
  parse_tokens_cost: number;
  api_usage_cost: number;
  member_count: number;
}

export class Context7 implements ProviderAdapter {
  id = 'context7';
  name = 'Context7';

  async fetchUsage(): Promise<Provider> {
    const sessionCookie = config.context7SessionCookie;

    if (!sessionCookie) {
      return new Provider(this.id, this.name, 'Not configured', []);
    }

    const teamspaceId = await this.fetchDefaultTeamspaceId(sessionCookie);
    const usage = await this.fetchTeamspaceUsage(sessionCookie, teamspaceId);

    const plan = usage.ownerPlan.charAt(0).toUpperCase() + usage.ownerPlan.slice(1);

    const windows: UsageWindow[] = [];

    // Monthly limit: creditBalance is remaining, quotaLimit is the cap
    if (usage.quotaLimit != null && usage.quotaLimit > 0) {
      const used = usage.quotaLimit - usage.creditBalance;
      windows.push(UsageWindow.fromCounts('monthly', Math.max(0, used), usage.quotaLimit, null));
    }

    // Current month aggregate
    const currentMonth = usage.dailyStats
      .filter((d) => d.date.startsWith(this.currentMonthPrefix()))
      .reduce(
        (acc, d) => ({
          parseTokens: acc.parseTokens + d.parse_tokens,
          searchRequests: acc.searchRequests + d.search_requests,
          fetchDocsRequests: acc.fetchDocsRequests + d.fetch_docs_requests,
          cost: acc.cost + d.parse_tokens_cost + d.api_usage_cost,
        }),
        { parseTokens: 0, searchRequests: 0, fetchDocsRequests: 0, cost: 0 },
      );

    windows.push(
      UsageWindow.fromCounts(
        'parse_tokens',
        currentMonth.parseTokens,
        currentMonth.parseTokens,
        null,
      ),
    );
    windows.push(
      UsageWindow.fromCounts(
        'searches',
        currentMonth.searchRequests,
        currentMonth.searchRequests,
        null,
      ),
    );

    return new Provider(this.id, this.name, plan, [ModelUsage.from('Context7', windows)]);
  }

  private async fetchDefaultTeamspaceId(sessionCookie: string): Promise<string> {
    const response = await fetch(TEAMSPACE_API, {
      headers: {
        cookie: sessionCookie,
        'user-agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching teamspaces`);
    }

    const teamspaces = (await response.json()) as { id: string }[];

    if (!teamspaces?.length) {
      throw new Error('No teamspaces found');
    }

    return teamspaces[0].id;
  }

  private async fetchTeamspaceUsage(
    sessionCookie: string,
    teamspaceId: string,
  ): Promise<TeamspaceUsage> {
    const url = `${TEAMSPACE_USAGE_API}/${encodeURIComponent(teamspaceId)}`;

    const response = await fetch(url, {
      headers: {
        cookie: sessionCookie,
        'user-agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching teamspace usage`);
    }

    const raw = (await response.json()) as TeamspaceUsage;

    return raw;
  }

  private currentMonthPrefix(): string {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');

    return `${y}-${m}`;
  }
}
