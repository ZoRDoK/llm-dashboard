import { z } from 'zod';
import { parseCookiePairs, refreshCookiesViaBrowser } from '../browser-cookies.js';
import { config } from '../config.js';
import { fetchRaw } from '../fetch-utils.js';
import { createLogger } from '../logger.js';
import { Provider } from '../provider.js';
import type { ProviderAdapter } from '../types.js';
import { UsageWindow } from '../usage-window.js';
import { fetchOpenCodeApi } from './opencode-http.js';

const log = createLogger('adapter:opencode-go');

const GO_PLAN_NAME = 'Go Plan';
const GO_STATUS_PATH = '/go/status';
const GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const OPENCODE_DOMAIN = 'opencode.ai';
const SESSION_COOKIE_NAME = '__Host-console_session';

/** 100,000,000 microcents make $1.00 (the plan limits are $12 / $30 / $60). */
const MICROCENTS_PER_DOLLAR = 100_000_000;
const PERCENT_MAX = 100;
/** Rounds a percent to one decimal (e.g. 2.3004 → 2.3). */
const PERCENT_ROUND_FACTOR = 10;

// Money fields are strings in microcents. `month` has no resetsAt, so it is
// optional and nullable; `fiveHour`/`week` carry an ISO timestamp.
const MeterSchema = z.object({
  limitMicroCents: z.string(),
  usedMicroCents: z.string(),
  resetsAt: z.string().nullish(),
});

const GoStatusSchema = z.object({
  access: z.object({
    meters: z.object({
      fiveHour: MeterSchema,
      week: MeterSchema,
      month: MeterSchema,
    }),
  }),
});

type Meter = z.infer<typeof MeterSchema>;

// API-key usage: percent + reset only (no dollar amounts are exposed).
const UsageMeterSchema = z.object({
  status: z.string().optional(),
  percent: z.number(),
  resetsAt: z.iso.datetime({ offset: true }).nullish(),
});

const GoUsageSchema = z.object({
  usage: z.object({
    rolling: UsageMeterSchema,
    weekly: UsageMeterSchema,
    monthly: UsageMeterSchema,
  }),
});

type UsageMeter = z.infer<typeof UsageMeterSchema>;

interface OpenCodeGoOptions {
  id?: string;
  name?: string;
  apiKey?: string;
  sessionCookie?: string;
  workspaceId?: string;
  /** CDP endpoint of this account's dedicated host Chrome profile. */
  cdpUrl?: string;
}

export class OpenCodeGo implements ProviderAdapter {
  readonly id: string;
  readonly name: string;
  private readonly apiKey: string | undefined;
  private readonly sessionCookie: string | undefined;
  private readonly workspaceId: string | undefined;
  private readonly cdpUrl: string | undefined;

  constructor(opts: OpenCodeGoOptions = {}) {
    this.id = opts.id ?? 'opencode-go';
    this.name = opts.name ?? 'OpenCode Go';
    // Only the default instance falls back to the env key; a second account
    // with an unset key must not silently reuse the first account's key.
    this.apiKey = opts.id === undefined ? (opts.apiKey ?? config.OPENCODE_GO_API_KEY) : opts.apiKey;
    this.sessionCookie = opts.sessionCookie ?? config.OPENCODE_GO_SESSION_COOKIE;
    this.workspaceId = opts.workspaceId ?? config.OPENCODE_GO_WORKSPACE_ID;
    this.cdpUrl = opts.cdpUrl;
  }

  async fetchUsage(): Promise<Provider> {
    const apiProvider = await this.fetchViaApiKey();

    if (apiProvider) {
      return apiProvider;
    }

    // Fallback: console session from the dedicated profile, then the env cookie.
    const sessionCookie = (await this.browserSessionCookie()) ?? this.sessionCookie;
    const workspaceId = this.workspaceId;

    if (!(sessionCookie && workspaceId)) {
      return Provider.notConfigured(this.id, this.name);
    }

    const status = await fetchOpenCodeApi(sessionCookie, workspaceId, GO_STATUS_PATH);
    const windows = goWindowsFromStatus(status);

    return Provider.fromAdapter(this.id, this.name, GO_PLAN_NAME, windows);
  }

  /** Usage by API key — the primary source; null when no key or request fails. */
  private async fetchViaApiKey(): Promise<Provider | null> {
    if (!this.apiKey) {
      return null;
    }

    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
    };

    try {
      const response = await fetchRaw(GO_USAGE_URL, { headers });

      if (!response.ok) {
        log.debug(
          { providerId: this.id, status: response.status },
          'Usage API rejected the key, falling back',
        );

        return null;
      }

      let windows: UsageWindow[];

      try {
        windows = goWindowsFromUsageApi(await response.json());
      } catch (err) {
        // A parse mismatch means the payload drifted from the schema — surface
        // it above debug so the fallback to cookie sources is visible.
        log.warn(
          { providerId: this.id, err: err instanceof Error ? err.message : String(err) },
          'Usage API payload mismatch, falling back',
        );

        return null;
      }

      return Provider.fromAdapter(this.id, this.name, GO_PLAN_NAME, windows);
    } catch (err) {
      log.debug(
        { providerId: this.id, err: err instanceof Error ? err.message : String(err) },
        'Usage API request failed, falling back',
      );

      return null;
    }
  }

  /**
   * Live console session cookie from this account's dedicated Chrome profile,
   * or undefined when the profile is not running / not logged in yet.
   */
  private async browserSessionCookie(): Promise<string | undefined> {
    if (!this.cdpUrl) {
      return undefined;
    }

    const result = await refreshCookiesViaBrowser({
      domain: OPENCODE_DOMAIN,
      cookieName: SESSION_COOKIE_NAME,
      exactName: true,
      cdpUrl: this.cdpUrl,
    });

    if (!(result.ok && result.cookieString)) {
      log.debug(
        { providerId: this.id, cdpUrl: this.cdpUrl },
        'Profile session unavailable, env cookie fallback',
      );

      return undefined;
    }

    return parseCookiePairs(result.cookieString).find((pair) => pair.name === SESSION_COOKIE_NAME)
      ?.value;
  }
}

/** One API meter as a dashboard window: percent used + reset time. */
function usageWindow(label: string, meter: UsageMeter): UsageWindow {
  return UsageWindow.fromApi(label, meter.percent, meter.resetsAt ?? null);
}

/**
 * Build the `5h` / `weekly` / `monthly` windows from a /zen/go/v1/usage
 * payload. Pure so unit tests can cover it without network access.
 */
export function goWindowsFromUsageApi(payload: unknown): UsageWindow[] {
  const { usage } = GoUsageSchema.parse(payload);

  const entries = [
    { label: '5h', meter: usage.rolling },
    { label: 'weekly', meter: usage.weekly },
    { label: 'monthly', meter: usage.monthly },
  ];

  return entries.map(({ label, meter }) => usageWindow(label, meter));
}

/** One API meter as a dashboard window: percent of the dollar limit + reset time. */
function meterWindow(label: string, meter: Meter): UsageWindow {
  const used = Number(meter.usedMicroCents) / MICROCENTS_PER_DOLLAR;
  const limit = Number(meter.limitMicroCents) / MICROCENTS_PER_DOLLAR;
  const usedPercent =
    limit > 0
      ? Math.round((used / limit) * PERCENT_MAX * PERCENT_ROUND_FACTOR) / PERCENT_ROUND_FACTOR
      : null;
  const valueLabel = `$${used.toFixed(2)} of $${limit.toFixed(2)}`;

  return UsageWindow.fromApi(label, usedPercent, meter.resetsAt ?? null, null, valueLabel);
}

/**
 * Build the `5h` / `weekly` / `monthly` windows from a `/go/status` payload.
 * Pure so unit tests can cover it without network access.
 */
export function goWindowsFromStatus(payload: unknown): UsageWindow[] {
  const status = GoStatusSchema.parse(payload);
  const meters = status.access.meters;

  const entries = [
    { label: '5h', meter: meters.fiveHour },
    { label: 'weekly', meter: meters.week },
    { label: 'monthly', meter: meters.month },
  ];

  return entries.map(({ label, meter }) => meterWindow(label, meter));
}
