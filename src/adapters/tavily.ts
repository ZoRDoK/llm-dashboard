import { z } from 'zod';
import { config } from '../config.js';
import { fetchAndParse } from '../fetch-utils.js';
import { Provider } from '../provider.js';
import type { ProviderAdapter } from '../types.js';
import { UsageWindow } from '../usage-window.js';

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

interface TavilyOptions {
  id?: string;
  name?: string;
  apiKey?: string;
}

export class Tavily implements ProviderAdapter {
  readonly id: string;
  readonly name: string;
  private readonly apiKey: string | undefined;

  constructor(opts: TavilyOptions = {}) {
    this.id = opts.id ?? 'tavily';
    this.name = opts.name ?? 'Tavily';
    this.apiKey = opts.apiKey ?? config.TAVILY_API_KEY;
  }

  async fetchUsage(): Promise<Provider> {
    const apiKey = this.apiKey;

    if (!apiKey) {
      return Provider.notConfigured(this.id, this.name);
    }

    const data = await fetchAndParse(USAGE_ENDPOINT, apiKey, UsageSchema);

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
      { modelName: 'Tavily', windows },
    ]);
  }
}
