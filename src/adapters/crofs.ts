import { z } from 'zod';
import { config } from '../config.js';
import { ModelUsage } from '../model-usage.js';
import { Provider } from '../provider.js';
import type { ProviderAdapter } from '../types.js';
import { UsageWindow } from '../usage-window.js';

const FETCH_TIMEOUT_MS = 5_000;
const ENDPOINT = 'https://crof.ai/usage_api/';

// Daily reset at 08:00 UTC+3 = 05:00 UTC
const RESET_HOUR_UTC = 5;
const RESET_MINUTE = 40;

const ResponseSchema = z.object({
  usable_requests: z.number().nullable(),
  requests_plan: z.number().nullable(),
  credits: z.number(),
});

type CrofsResponse = z.infer<typeof ResponseSchema>;

/**
 * Compute the next reset timestamp in UTC at 07:40.
 * Returns ISO string or null on invalid date.
 */
function nextResetIso(): string | null {
  const now = new Date();
  const next = new Date(0);

  next.setUTCFullYear(now.getUTCFullYear());
  next.setUTCMonth(now.getUTCMonth());
  next.setUTCDate(now.getUTCDate());
  next.setUTCHours(RESET_HOUR_UTC, RESET_MINUTE, 0, 0);

  // Already passed today → tomorrow
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }

  const ms = next.getTime();
  if (!Number.isFinite(ms)) {
    return null;
  }

  return next.toISOString();
}

export class Crofs implements ProviderAdapter {
  id = 'crofs';
  name = 'Crofs';

  async fetchUsage(): Promise<Provider> {
    const apiKey = config.crofsApiKey;

    if (!apiKey) {
      return new Provider(this.id, this.name, 'Not configured', []);
    }

    const data = await this.fetchData(apiKey);

    const windows: UsageWindow[] = [];
    const resetAt = nextResetIso();

    const plan = data.requests_plan ?? data.usable_requests ?? 0;

    if (plan > 0) {
      const used = Math.max(0, plan - (data.usable_requests ?? 0));

      windows.push(UsageWindow.fromCounts('daily', used, plan, resetAt));
    } else if (data.usable_requests !== null) {
      windows.push(
        UsageWindow.fromApi('daily', null, resetAt, null, `${data.usable_requests} requests left`),
      );
    }

    windows.push(UsageWindow.fromApi('credits', null, null, data.credits));

    return new Provider(this.id, this.name, 'API', [ModelUsage.from('API Usage', windows)]);
  }

  private async fetchData(apiKey: string): Promise<CrofsResponse> {
    const payload = {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    };

    const response = await fetch(ENDPOINT, payload);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const raw = (await response.json()) as unknown;

    return ResponseSchema.parse(raw);
  }
}
