import { z } from 'zod';
import { config } from '../config.js';
import { fetchJson } from '../fetch-utils.js';
import { parseNumber } from '../parse-utils.js';
import { Provider } from '../provider.js';
import { msToIso } from '../time-utils.js';
import type { ProviderAdapter } from '../types.js';
import { UsageWindow } from '../usage-window.js';

const BASE_URL = 'https://api.z.ai';
const QUOTA_ENDPOINT = `${BASE_URL}/api/monitor/usage/quota/limit`;
const SUBSCRIPTION_ENDPOINT = `${BASE_URL}/api/biz/subscription/list`;
const TOKENS_UNIT_5H = 3;
const TOKENS_UNIT_WEEKLY = 6;
const TOKENS_NUMBER_5H = 5;

const NumericSchema = z.union([z.number(), z.string()]).optional().nullable();

const LimitSchema = z.object({
  type: z.string(),
  unit: NumericSchema,
  number: NumericSchema,
  usage: NumericSchema,
  total: NumericSchema,
  percentage: NumericSchema,
  currentValue: NumericSchema,
  nextResetTime: NumericSchema,
});

const DirectQuotaSchema = z.object({
  limits: z.array(LimitSchema),
});

const EnvelopedQuotaSchema = z.object({
  data: DirectQuotaSchema,
});

const QuotaSchema = z.union([DirectQuotaSchema, EnvelopedQuotaSchema]);

const SubscriptionSchema = z.object({
  productName: z.string().optional().nullable(),
  nextRenewTime: z.union([z.string(), z.number()]).optional().nullable(),
  status: z.string().optional().nullable(),
  inCurrentPeriod: z.boolean().optional().nullable(),
});

const DirectSubscriptionSchema = z.array(SubscriptionSchema);

const EnvelopedSubscriptionSchema = z.object({
  data: DirectSubscriptionSchema,
});

const SubscriptionResponseSchema = z.union([DirectSubscriptionSchema, EnvelopedSubscriptionSchema]);

type ZaiQuota = z.infer<typeof QuotaSchema>;
export type ZaiLimit = z.infer<typeof LimitSchema>;
type ZaiSubscription = z.infer<typeof SubscriptionSchema>;

export class Zai implements ProviderAdapter {
  id = 'zai';
  name = 'Z.AI';

  async fetchUsage(): Promise<Provider> {
    const apiKey = config.ZAI_API_KEY ?? config.GLM_API_KEY;

    if (!apiKey) {
      return Provider.notConfigured(this.id, this.name);
    }

    const quotaRequest = this.fetchQuota(apiKey);
    const subscriptionRequest = this.fetchSubscriptions(apiKey);
    const [quotaResult, subscriptionResult] = await Promise.allSettled([
      quotaRequest,
      subscriptionRequest,
    ]);

    if (quotaResult.status === 'rejected') {
      throw quotaResult.reason;
    }

    const subscriptions = subscriptionResult.status === 'fulfilled' ? subscriptionResult.value : [];
    const subscription = currentSubscription(subscriptions);
    const plan = subscription?.productName ?? 'API';
    const monthlyResetAt = subscriptionResetAt(subscription);
    const windows = this.buildWindows(quotaResult.value, monthlyResetAt);

    return new Provider(this.id, this.name, plan, [{ modelName: 'Quota', windows }]);
  }

  private buildWindows(data: ZaiQuota, monthlyResetAt: string | null): UsageWindow[] {
    const quota = 'limits' in data ? data : data.data;
    const windows: UsageWindow[] = [];

    for (const limit of quota.limits) {
      const window = this.windowFromLimit(limit, monthlyResetAt);

      if (window) {
        windows.push(window);
      }
    }

    return windows;
  }

  private windowFromLimit(limit: ZaiLimit, monthlyResetAt: string | null): UsageWindow | null {
    const limitType = limit.type.toUpperCase();

    if (limitType !== 'TOKENS_LIMIT' && limitType !== 'TIME_LIMIT') {
      return null;
    }

    const label = labelForLimit(limit);
    const resetAt =
      limitType === 'TIME_LIMIT'
        ? timeLimitResetAt(limit, monthlyResetAt)
        : timestampToIso(limit.nextResetTime);

    const percent = zaiUsedPercent(limit, label);

    if (percent != null) {
      return UsageWindow.fromApi(label, percent, resetAt);
    }

    // Fallback: compute from used/total counts when percentage is absent
    const used = parseNumber(limit.currentValue);
    const total = parseNumber(limit.usage) ?? parseNumber(limit.total);

    if (used != null && total != null && total > 0) {
      return UsageWindow.fromCounts(label, used, total, resetAt);
    }

    return null;
  }

  private async fetchQuota(apiKey: string): Promise<ZaiQuota> {
    const response = await fetchJson(QUOTA_ENDPOINT, apiKey);

    return QuotaSchema.parse(response);
  }

  private async fetchSubscriptions(apiKey: string): Promise<ZaiSubscription[]> {
    const response = await fetchJson(SUBSCRIPTION_ENDPOINT, apiKey);
    const parsed = SubscriptionResponseSchema.parse(response);

    return Array.isArray(parsed) ? parsed : parsed.data;
  }
}

function currentSubscription(subscriptions: ZaiSubscription[]): ZaiSubscription | null {
  for (const subscription of subscriptions) {
    const status = subscription.status?.toUpperCase();
    const isValid = status === 'VALID' || status === 'ACTIVE';

    if (subscription.inCurrentPeriod === true && isValid && subscription.productName) {
      return subscription;
    }
  }

  for (const subscription of subscriptions) {
    if (subscription.productName) {
      return subscription;
    }
  }

  return null;
}

function labelForLimit(limit: ZaiLimit): string {
  const limitType = limit.type.toUpperCase();

  if (limitType === 'TIME_LIMIT') {
    return 'searches';
  }

  const unit = parseNumber(limit.unit);
  const number = parseNumber(limit.number);

  if (unit === TOKENS_UNIT_5H && number === TOKENS_NUMBER_5H) {
    return '5h';
  }

  if (unit === TOKENS_UNIT_WEEKLY) {
    return 'weekly';
  }

  return 'tokens';
}

function timeLimitResetAt(limit: ZaiLimit, monthlyResetAt: string | null): string | null {
  const resetAt = timestampToIso(limit.nextResetTime);

  if (resetAt) {
    return resetAt;
  }

  return monthlyResetAt;
}

function subscriptionResetAt(subscription: ZaiSubscription | null): string | null {
  if (!subscription) {
    return null;
  }

  return dateToStartOfDayIso(subscription.nextRenewTime);
}

function dateToStartOfDayIso(value: string | number | null | undefined): string | null {
  if (value == null) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return timestampToIso(value);
  }

  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  ).toISOString();
}

function timestampToIso(value: number | string | null | undefined): string | null {
  const ms = parseNumber(value);

  if (ms == null) {
    return null;
  }

  return msToIso(ms);
}

/**
 * Normalize percent usage for a Z.AI limit window.
 *
 * Returns null when percentage is absent, so the caller can fall back to
 * used/total counts. Z.AI reports 1% for an empty 5h window with no count
 * fields; that rounding artifact is reported as 0.
 */
export function zaiUsedPercent(limit: ZaiLimit, label: string): number | null {
  const percentage = parseNumber(limit.percentage);

  if (
    label === '5h' &&
    percentage === 1 &&
    parseNumber(limit.currentValue) == null &&
    parseNumber(limit.usage) == null &&
    parseNumber(limit.total) == null
  ) {
    return 0;
  }

  if (percentage != null) {
    return percentage;
  }

  return null;
}
