import { z } from 'zod';
import { config } from '../config.js';
import { ModelUsage } from '../model-usage.js';
import { Provider } from '../provider.js';
import type { ProviderAdapter } from '../types.js';
import { UsageWindow } from '../usage-window.js';

const FETCH_TIMEOUT_MS = 5_000;
const USAGE_ENDPOINT = 'https://api.tavily.com/usage';

const UsageSchema = z.object({
  key: z.object({
    usage: z.number(),
    limit: z.number().nullable(),
    search_usage: z.number(),
    extract_usage: z.number(),
    crawl_usage: z.number(),
    map_usage: z.number(),
    research_usage: z.number(),
  }),
  account: z.object({
    current_plan: z.string(),
    plan_usage: z.number(),
    plan_limit: z.number(),
    paygo_usage: z.number(),
    paygo_limit: z.number().nullable(),
    search_usage: z.number(),
    extract_usage: z.number(),
    crawl_usage: z.number(),
    map_usage: z.number(),
    research_usage: z.number(),
  }),
});

type TavilyResponse = z.infer<typeof UsageSchema>;

export class Tavily implements ProviderAdapter {
  id = 'tavily';
  name = 'Tavily';

  async fetchUsage(): Promise<Provider> {
    const apiKey = config.tavilyApiKey;

    if (!apiKey) {
      return new Provider(this.id, this.name, 'Not configured', []);
    }

    const data = await this.fetchData(apiKey);

    const windows: UsageWindow[] = [];

    // Key-level usage (per-api-key limit)
    if (data.key.limit != null && data.key.limit > 0) {
      windows.push(UsageWindow.fromCounts('key', data.key.usage, data.key.limit, null));
    }

    // Account-level plan usage
    if (data.account.plan_limit > 0) {
      windows.push(
        UsageWindow.fromCounts('plan', data.account.plan_usage, data.account.plan_limit, null),
      );
    }

    // Pay-as-you-go usage (if applicable)
    if (data.account.paygo_limit != null && data.account.paygo_limit > 0) {
      windows.push(
        UsageWindow.fromCounts('paygo', data.account.paygo_usage, data.account.paygo_limit, null),
      );
    }

    return new Provider(this.id, this.name, data.account.current_plan, [
      ModelUsage.from('Tavily', windows),
    ]);
  }

  private async fetchData(apiKey: string): Promise<TavilyResponse> {
    const payload = {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    };

    const response = await fetch(USAGE_ENDPOINT, payload);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const raw = (await response.json()) as unknown;

    return UsageSchema.parse(raw);
  }
}
