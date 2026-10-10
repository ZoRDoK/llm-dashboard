import { z } from 'zod';
import { config } from '../config.js';
import { Provider } from '../provider.js';
import type { ProviderAdapter } from '../types.js';
import { UsageWindow } from '../usage-window.js';
import { fetchOpenCodeApi } from './opencode-http.js';

const ZEN_PLAN_NAME = 'Zen';
const BILLING_STATUS_PATH = '/billing/status';

/** 100,000,000 microcents make $1.00. */
const MICROCENTS_PER_DOLLAR = 100_000_000;

// Only the balance is needed; the rest of the billing payload is ignored.
const BillingStatusSchema = z.object({
  balanceMicroCents: z.string(),
});

interface OpenCodeZenOptions {
  id?: string;
  name?: string;
  sessionCookie?: string;
  workspaceId?: string;
}

export class OpenCodeZen implements ProviderAdapter {
  readonly id: string;
  readonly name: string;
  private readonly sessionCookie: string | undefined;
  private readonly workspaceId: string | undefined;

  constructor(opts: OpenCodeZenOptions = {}) {
    this.id = opts.id ?? 'opencode';
    this.name = opts.name ?? 'OpenCode Zen';
    // Same account as the Go plan — reuse its cookie + workspace.
    this.sessionCookie = opts.sessionCookie ?? config.OPENCODE_GO_SESSION_COOKIE;
    this.workspaceId = opts.workspaceId ?? config.OPENCODE_GO_WORKSPACE_ID;
  }

  async fetchUsage(): Promise<Provider> {
    const sessionCookie = this.sessionCookie;
    const workspaceId = this.workspaceId;

    if (!(sessionCookie && workspaceId)) {
      return Provider.notConfigured(this.id, this.name);
    }

    const status = await fetchOpenCodeApi(sessionCookie, workspaceId, BILLING_STATUS_PATH);

    const balance = zenBalanceFromStatus(status);
    const window = UsageWindow.fromApi('balance', null, null, null, `$${balance.toFixed(2)}`);

    return Provider.fromAdapter(this.id, this.name, ZEN_PLAN_NAME, [window]);
  }
}

/**
 * Zen dollar balance from a `/billing/status` payload. The API returns the
 * balance as a microcent string (100,000,000 microcents = $1.00). Pure so unit
 * tests can cover it without network access.
 */
export function zenBalanceFromStatus(payload: unknown): number {
  const status = BillingStatusSchema.parse(payload);
  const balance = Number(status.balanceMicroCents) / MICROCENTS_PER_DOLLAR;

  if (!Number.isFinite(balance)) {
    throw new Error(`OpenCode Zen balance is not a finite number: ${status.balanceMicroCents}`);
  }

  return balance;
}
