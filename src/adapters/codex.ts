import { z } from 'zod';
import { config } from '../config.js';
import { fetchJsonWith } from '../fetch-utils.js';
import { createLogger } from '../logger.js';
import { Provider } from '../provider.js';
import { epochToIso } from '../time-utils.js';
import type { ProviderAdapter } from '../types.js';
import { UsageWindow } from '../usage-window.js';
import { retryOn401 } from './auth-json.js';
import { CodexAuth } from './codex-auth.js';

const log = createLogger('adapter:codex');

const USAGE_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage';

const WhamWindowSchema = z.object({
  used_percent: z.number(),
  reset_at: z.number(),
  // Window length identifies what a window actually is: OpenAI temporarily
  // removed the 5-hour cap (July 2026), so the 5h window may come back in
  // either slot. Absent on legacy payloads. Extra fields such as
  // reset_after_seconds are ignored — reset_at stays the source of reset time.
  limit_window_seconds: z.number().optional(),
});

type WhamWindow = z.infer<typeof WhamWindowSchema>;

const WhamSchema = z.object({
  plan_type: z.string(),
  rate_limit: z.object({
    primary_window: WhamWindowSchema,
    secondary_window: WhamWindowSchema.nullable().optional(),
  }),
  credits: z
    .object({
      has_credits: z.boolean(),
      balance: z.string(),
    })
    .optional(),
});

type WhamResponse = z.infer<typeof WhamSchema>;

const SECONDS_PER_HOUR = 3_600;

const WINDOW_SECONDS_5H = 18_000;
const WINDOW_SECONDS_WEEKLY = 604_800;
const WINDOW_SECONDS_MONTHLY = 2_592_000;

/** limit_window_seconds → dashboard label for the known window lengths. */
const WINDOW_LABELS = new Map<number, string>([
  [WINDOW_SECONDS_5H, '5h'],
  [WINDOW_SECONDS_WEEKLY, 'weekly'],
  [WINDOW_SECONDS_MONTHLY, 'monthly'],
]);

/** Canonical dashboard window order; credits are appended after the sort. */
const LABEL_ORDER: readonly string[] = ['5h', 'weekly', 'monthly'];

function labelRank(label: string): number {
  const rank = LABEL_ORDER.indexOf(label);

  return rank === -1 ? LABEL_ORDER.length : rank;
}

/** Pick the label from the window length, or the legacy slot-based fallback. */
function labelFor(win: WhamWindow, fallback: string): string {
  const seconds = win.limit_window_seconds;

  if (seconds == null) {
    // Legacy payloads carry no window length: primary is weekly, secondary 5h.
    return fallback;
  }

  return WINDOW_LABELS.get(seconds) ?? `${Math.round(seconds / SECONDS_PER_HOUR)}h`;
}

const limitWindow = (win: WhamWindow, fallback: string): UsageWindow =>
  UsageWindow.fromApi(labelFor(win, fallback), win.used_percent, epochToIso(win.reset_at));

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
    } catch (err) {
      log.debug({ err }, 'Codex auth.json token unavailable, falling back to env token');

      token = config.OPENAI_CODEX_ACCESS_TOKEN ?? null;
    }

    if (!token) {
      return Provider.notConfigured(this.id, this.name);
    }

    // Token from env var can't be refreshed; token from auth may have been
    // invalidated after our freshness check — retryOn401 does one force-fresh re-fetch.
    return await retryOn401(token, fromAuth, auth, (t) => this.fetchProvider(t));
  }

  private async fetchProvider(token: string): Promise<Provider> {
    const data = await this.fetchData(token);
    const windows = this.buildWins(data);

    return new Provider(this.id, this.name, data.plan_type, [
      { modelName: data.plan_type, windows },
    ]);
  }

  private async fetchData(token: string): Promise<WhamResponse> {
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    const raw = await fetchJsonWith(USAGE_ENDPOINT, headers);

    return WhamSchema.parse(raw);
  }

  private buildWins(data: WhamResponse): UsageWindow[] {
    const secondary = data.rate_limit.secondary_window;

    const wins: UsageWindow[] = [];

    if (secondary) {
      wins.push(limitWindow(secondary, '5h'));
    }

    wins.push(limitWindow(data.rate_limit.primary_window, 'weekly'));

    wins.sort((a, b) => labelRank(a.label) - labelRank(b.label));

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
