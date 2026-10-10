import { z } from 'zod';
import { config } from '../config.js';
import { Provider } from '../provider.js';
import type { ProviderAdapter } from '../types.js';
import { UsageWindow } from '../usage-window.js';
import { fetchOpenCodeApi } from './opencode-http.js';

const GO_PLAN_NAME = 'Go Plan';
const GO_STATUS_PATH = '/go/status';

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

interface OpenCodeGoOptions {
  id?: string;
  name?: string;
  sessionCookie?: string;
  workspaceId?: string;
}

export class OpenCodeGo implements ProviderAdapter {
  readonly id: string;
  readonly name: string;
  private readonly sessionCookie: string | undefined;
  private readonly workspaceId: string | undefined;

  constructor(opts: OpenCodeGoOptions = {}) {
    this.id = opts.id ?? 'opencode-go';
    this.name = opts.name ?? 'OpenCode Go';
    this.sessionCookie = opts.sessionCookie ?? config.OPENCODE_GO_SESSION_COOKIE;
    this.workspaceId = opts.workspaceId ?? config.OPENCODE_GO_WORKSPACE_ID;
  }

  async fetchUsage(): Promise<Provider> {
    const sessionCookie = this.sessionCookie;
    const workspaceId = this.workspaceId;

    if (!(sessionCookie && workspaceId)) {
      return Provider.notConfigured(this.id, this.name);
    }

    const status = await fetchOpenCodeApi(sessionCookie, workspaceId, GO_STATUS_PATH);
    const windows = goWindowsFromStatus(status);

    return Provider.fromAdapter(this.id, this.name, GO_PLAN_NAME, windows);
  }
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
