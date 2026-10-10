import { z } from 'zod';
import { config } from '../config.js';
import { fetchAndParse } from '../fetch-utils.js';
import { Provider } from '../provider.js';
import type { ProviderAdapter } from '../types.js';
import { UsageWindow } from '../usage-window.js';

const ENDPOINT = 'https://api.synthetic.new/v2/quotas';
const PERCENT_MAX = 100;

const PeriodSchema = z.object({
  limit: z.number(),
  requests: z.number(),
  renewsAt: z.string(),
});

const QuotaSchema = z.object({
  subscription: PeriodSchema.optional(),
  search: z
    .object({
      hourly: PeriodSchema,
    })
    .optional(),
  freeToolCalls: PeriodSchema.optional(),
  weeklyTokenLimit: z
    .object({
      nextRegenAt: z.string(),
      percentRemaining: z.number(),
      maxCredits: z.string(),
      remainingCredits: z.string(),
      nextRegenCredits: z.string(),
    })
    .optional(),
  rollingFiveHourLimit: z
    .object({
      nextTickAt: z.string(),
      tickPercent: z.number(),
      remaining: z.number(),
      max: z.number(),
      limited: z.boolean(),
    })
    .optional(),
});

type SyntheticResponse = z.infer<typeof QuotaSchema>;

export class Synthetic implements ProviderAdapter {
  id = 'synthetic';
  name = 'Synthetic';

  async fetchUsage(): Promise<Provider> {
    const apiKey = config.SYNTHETIC_API_KEY;

    if (!apiKey) {
      return Provider.notConfigured(this.id, this.name);
    }

    const data = await fetchAndParse(ENDPOINT, apiKey, QuotaSchema);
    const windows = buildWindows(data);

    return new Provider(this.id, this.name, 'API', [{ modelName: 'Quota', windows }]);
  }
}

function buildWindows(data: SyntheticResponse): UsageWindow[] {
  const windows: UsageWindow[] = [];

  const weekly = data.weeklyTokenLimit;

  if (weekly) {
    const used = clampPercent(PERCENT_MAX - weekly.percentRemaining);

    windows.push(
      UsageWindow.fromApi(
        'weekly',
        used,
        weekly.nextRegenAt,
        null,
        `${weekly.remainingCredits}/${weekly.maxCredits}`,
      ),
    );
  }

  const rolling = data.rollingFiveHourLimit;

  if (rolling && rolling.max > 0) {
    const used = clampCount(rolling.max - rolling.remaining, rolling.max);

    windows.push(UsageWindow.fromCounts('5h', used, rolling.max, rolling.nextTickAt));
  }

  const sub = data.subscription;

  if (sub && sub.limit > 0) {
    windows.push(
      UsageWindow.fromCounts('sub', clampCount(sub.requests, sub.limit), sub.limit, sub.renewsAt),
    );
  }

  const search = data.search?.hourly;

  if (search && search.limit > 0) {
    windows.push(
      UsageWindow.fromCounts(
        'search',
        clampCount(search.requests, search.limit),
        search.limit,
        search.renewsAt,
      ),
    );
  }

  return windows;
}

/** Clamp a percentage into the valid 0..100 range; the Synthetic API is still under development. */
function clampPercent(value: number): number {
  return Math.min(Math.max(0, value), PERCENT_MAX);
}

/** Clamp a used count into 0..total so validation never throws on transient overshoots. */
function clampCount(used: number, total: number): number {
  return Math.min(Math.max(0, used), total);
}
