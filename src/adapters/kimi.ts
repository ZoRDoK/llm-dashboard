import { z } from 'zod';
import { config } from '../config.js';
import { fetchAndParse } from '../fetch-utils.js';
import { parseNumber } from '../parse-utils.js';
import { Provider } from '../provider.js';
import type { ProviderAdapter } from '../types.js';
import { UsageWindow } from '../usage-window.js';

const KIMI_SESSION_MINUTES = 300;
const ENDPOINT = 'https://api.kimi.com/coding/v1/usages';

const NumericStringSchema = z.string().optional().nullable();

const UsageSchema = z.object({
  limit: NumericStringSchema,
  used: NumericStringSchema,
  remaining: NumericStringSchema,
  resetTime: z.string().optional().nullable(),
});

const LimitSchema = z.object({
  window: z
    .object({
      duration: z.number().optional().nullable(),
      timeUnit: z.string().optional().nullable(),
    })
    .optional()
    .nullable(),
  detail: UsageSchema.optional().nullable(),
});

const ResponseSchema = z.object({
  user: z
    .object({
      membership: z
        .object({
          level: z.string().optional().nullable(),
        })
        .optional()
        .nullable(),
      userId: z.string().optional().nullable(),
    })
    .optional()
    .nullable(),
  usage: UsageSchema.optional().nullable(),
  limits: z.array(LimitSchema).optional().nullable(),
  totalQuota: z
    .object({
      limit: NumericStringSchema,
      remaining: NumericStringSchema,
      used: NumericStringSchema,
    })
    .partial()
    .optional()
    .nullable(),
});

type KimiResponse = z.infer<typeof ResponseSchema>;
type KimiUsage = z.infer<typeof UsageSchema>;
type KimiLimit = z.infer<typeof LimitSchema>;

export class Kimi implements ProviderAdapter {
  id = 'kimi';
  name = 'Kimi';

  async fetchUsage(): Promise<Provider> {
    const apiKey = config.KIMI_API_KEY;

    if (!apiKey) {
      return Provider.notConfigured(this.id, this.name);
    }

    const data = await fetchAndParse(ENDPOINT, apiKey, ResponseSchema);
    const windows = this.buildWindows(data);
    const plan = this.planName(data.user?.membership?.level);

    return new Provider(this.id, this.name, plan, [{ modelName: 'Coding', windows }]);
  }

  private buildWindows(data: KimiResponse): UsageWindow[] {
    const windows: UsageWindow[] = [];
    const labels = new Map<string, number>();

    for (const limit of data.limits ?? []) {
      const baseLabel = this.labelForLimit(limit);
      const count = labels.get(baseLabel) ?? 0;
      const nextCount = count + 1;
      const label = count === 0 ? baseLabel : `${baseLabel} ${nextCount}`;
      const interval = this.windowFromUsage(label, limit.detail ?? null);

      if (interval) {
        labels.set(baseLabel, nextCount);
        windows.push(interval);
      }
    }

    const weekly = this.windowFromUsage('weekly', data.usage ?? null);

    if (weekly) {
      windows.push(weekly);
    }

    const monthly = this.monthlyWindow(data.totalQuota ?? null);

    if (monthly) {
      windows.push(monthly);
    }

    return windows;
  }

  private labelForLimit(limit: KimiLimit): string {
    const duration = limit.window?.duration;
    const timeUnit = limit.window?.timeUnit;

    if (duration === KIMI_SESSION_MINUTES && timeUnit === 'TIME_UNIT_MINUTE') {
      return '5h';
    }

    return 'window';
  }

  private windowFromUsage(label: string, usage: KimiUsage | null): UsageWindow | null {
    if (!usage) {
      return null;
    }

    const total = parseNumber(usage.limit);
    const used = parseNumber(usage.used);
    const remaining = parseNumber(usage.remaining);

    if (total == null || total <= 0) {
      return null;
    }

    if (used != null) {
      return UsageWindow.fromCounts(label, used, total, usage.resetTime ?? null);
    }

    if (remaining == null) {
      return null;
    }

    const inferredUsed = Math.max(0, total - remaining);

    return UsageWindow.fromCounts(label, inferredUsed, total, usage.resetTime ?? null);
  }

  private monthlyWindow(quota: KimiResponse['totalQuota'] | null): UsageWindow | null {
    if (!quota) {
      return null;
    }

    const total = parseNumber(quota.limit);
    const remaining = parseNumber(quota.remaining);

    if (total == null || total <= 0 || remaining == null) {
      return null;
    }

    const used = Math.max(0, total - remaining);

    return UsageWindow.fromCounts('monthly', used, total, null);
  }

  private planName(level: string | null | undefined): string {
    if (!level) {
      return 'Coding';
    }

    return level.replace(/^LEVEL_/i, '').toLowerCase();
  }
}
