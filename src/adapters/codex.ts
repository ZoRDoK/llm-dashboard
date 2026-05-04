import { z } from 'zod';
import { config } from '../config';
import { ModelUsage } from '../model-usage';
import { Provider } from '../provider';
import { epochToIso } from '../time-utils';
import type { ProviderAdapter } from '../types';
import { UsageWindow } from '../usage-window';
import { CodexAuth } from './codex-auth';

const FETCH_TIMEOUT_MS = 5_000;
const USAGE_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage';

const WhamSchema = z.object({
  plan_type: z.string(),
  rate_limit: z.object({
    primary_window: z.object({
      used_percent: z.number(),
      reset_at: z.number(),
    }),
    secondary_window: z.object({
      used_percent: z.number(),
      reset_at: z.number(),
    }),
  }),
  credits: z
    .object({
      has_credits: z.boolean(),
      balance: z.string(),
    })
    .optional(),
});

type WhamResponse = z.infer<typeof WhamSchema>;

const auth = new CodexAuth();

export class Codex implements ProviderAdapter {
  id = 'codex';
  name = 'OpenAI Codex';

  async fetchUsage(): Promise<Provider> {
    let token: string | null = null;
    let fromAuth = false;

    try {
      token = await auth.getToken();
      fromAuth = true;
    } catch {
      // auth.json not found, fall back to env var
      token = config.openaiCodexAccessToken ?? null;
    }

    if (!token) {
      return new Provider(this.id, this.name, 'Not configured', []);
    }

    try {
      const data = await this.fetchData(token);
      const windows = this.buildWins(data);

      return new Provider(this.id, this.name, data.plan_type, [
        ModelUsage.from(data.plan_type, windows),
      ]);
    } catch (err) {
      // Token from env var can't be refreshed; token from auth may have been
      // invalidated after our freshness check — do one force-fresh and retry.
      if (fromAuth && err instanceof Error && /^HTTP 401/.test(err.message)) {
        auth.clearCache();

        try {
          const fresh = await auth.getToken();
          const data = await this.fetchData(fresh);
          const windows = this.buildWins(data);

          return new Provider(this.id, this.name, data.plan_type, [
            ModelUsage.from(data.plan_type, windows),
          ]);
        } catch {
          // fall through to throw the original 401
        }
      }

      throw err;
    }
  }

  private async fetchData(token: string): Promise<WhamResponse> {
    const payload = {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    };

    const response = await fetch(USAGE_ENDPOINT, payload);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const raw = (await response.json()) as unknown;

    return WhamSchema.parse(raw);
  }

  private buildWins(data: WhamResponse): UsageWindow[] {
    const primary = data.rate_limit.primary_window;
    const secondary = data.rate_limit.secondary_window;

    const wins: UsageWindow[] = [
      UsageWindow.fromApi('5h', primary.used_percent, epochToIso(primary.reset_at)),
      UsageWindow.fromApi('weekly', secondary.used_percent, epochToIso(secondary.reset_at)),
    ];

    if (data.credits?.has_credits && Number(data.credits.balance) > 0) {
      wins.push(
        UsageWindow.fromApi(
          'credits',
          null,
          null,
          Number(data.credits.balance),
          `$${data.credits.balance} remaining`,
        ),
      );
    }

    return wins;
  }
}
