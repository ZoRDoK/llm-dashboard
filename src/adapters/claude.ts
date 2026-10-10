import { z } from 'zod';
import { config } from '../config.js';
import { fetchJsonWith } from '../fetch-utils.js';
import { Provider } from '../provider.js';
import type { ProviderAdapter } from '../types.js';
import { UsageWindow } from '../usage-window.js';
import { retryOn401 } from './auth-json.js';
import { ClaudeAuth } from './claude-auth.js';

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

const WindowSchema = z
  .object({
    utilization_percentage: z.number().optional().nullable(),
    used_percentage: z.number().optional().nullable(),
    utilization: z.number().optional().nullable(),
    resets_at: z.string().optional().nullable(),
    reset_at: z.string().optional().nullable(),
  })
  .passthrough();

const UsageResponseSchema = z
  .object({
    five_hour: WindowSchema.optional().nullable(),
    seven_day: WindowSchema.optional().nullable(),
    subscription_type: z.string().optional().nullable(),
    rate_limit_tier: z.string().optional().nullable(),
  })
  .passthrough();

type UsageResponse = z.infer<typeof UsageResponseSchema>;

const extractPercent = (window_: z.infer<typeof WindowSchema>): number | null =>
  window_.utilization_percentage ?? window_.used_percentage ?? window_.utilization ?? null;

const extractReset = (window_: z.infer<typeof WindowSchema>): string | null =>
  window_.resets_at ?? window_.reset_at ?? null;

function isNotConfiguredError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('No Anthropic auth entry');
}

const auth = new ClaudeAuth();

export class Claude implements ProviderAdapter {
  id = 'claude';
  name = 'Claude';

  async fetchUsage(): Promise<Provider> {
    let token: string | null = null;
    let fromAuth = false;

    try {
      token = await auth.getToken();
      fromAuth = true;
    } catch (err) {
      if (!isNotConfiguredError(err)) {
        // Temporary failure (e.g. refresh rate-limited) — re-throw so
        // provider-manager can serve stale cached data instead of overwriting it.
        throw err;
      }

      // auth.json doesn't exist — fall back to env var
      token = config.CLAUDE_ACCESS_TOKEN ?? null;
    }

    if (!token) {
      return Provider.notConfigured(this.id, this.name);
    }

    // Token from auth may be invalidated after our freshness check —
    // retryOn401 does one force-fresh re-fetch on HTTP 401.
    return await retryOn401(token, fromAuth, auth, (t) => this.fetchProvider(t));
  }

  private async fetchProvider(token: string): Promise<Provider> {
    const data = await this.fetchData(token);
    const windows = this.buildWins(data);
    const plan = data.subscription_type ?? data.rate_limit_tier ?? 'Pro';

    return new Provider(this.id, this.name, plan, [{ modelName: plan, windows }]);
  }

  private async fetchData(token: string): Promise<UsageResponse> {
    const headers = {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
    };

    const raw = await fetchJsonWith(USAGE_ENDPOINT, headers);

    return UsageResponseSchema.parse(raw);
  }

  private buildWins(data: UsageResponse): UsageWindow[] {
    const windows: UsageWindow[] = [];

    if (data.five_hour) {
      windows.push(
        UsageWindow.fromApi('5h', extractPercent(data.five_hour), extractReset(data.five_hour)),
      );
    }

    if (data.seven_day) {
      windows.push(
        UsageWindow.fromApi('weekly', extractPercent(data.seven_day), extractReset(data.seven_day)),
      );
    }

    return windows;
  }
}
