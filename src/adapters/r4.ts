import { z } from 'zod';

import {
  evaluateInPage,
  navigateViaBrowser,
  refreshCookiesViaBrowser,
  restoreCookiesViaBrowser,
} from '../browser-cookies.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { Provider } from '../provider.js';
import type { ProviderAdapter } from '../types.js';
import { UsageWindow } from '../usage-window.js';

const log = createLogger('adapter:r4');

const ID = 'r4';
const NAME = 'R4 Coder';
const DOMAIN = 'r4.codes';
const DASHBOARD_URL = `https://${DOMAIN}/dashboard/overview`;
const GRANT_URL = 'https://api.r4.codes/rpc/billing/getGrant';
const SESSION_COOKIE = '__Secure-better-auth.session_token';
const CF_CLEARANCE_COOKIE = 'cf_clearance';
const COOKIE_SEPARATOR = '; ';
const MONTHLY_LABEL = 'monthly';
const ROUND_SCALE = 100;

// r4.codes is a Cloudflare-protected SPA whose billing RPC answers only a
// same-origin call made from a real dashboard tab: the in-page fetch inherits
// the page's cookies and CORS allowance, while Node's own HTTP client is
// rejected by the TLS-fingerprint challenge with an HTML body. The expression
// returns the raw body text so this adapter, not the page, decides what a
// valid grant looks like.
const GRANT_EXPRESSION = `fetch('${GRANT_URL}',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.text())`;

const NOT_CONFIGURED_MSG = `Log into ${DOMAIN} in the Chrome UI, or set R4_SESSION_TOKEN`;
const SESSION_EXPIRED_MSG = `R4 session expired — log into ${DOMAIN} in the Chrome UI and re-set R4_SESSION_TOKEN`;

// The session cookie is the load-bearing one; a challenged session also needs
// the Cloudflare clearance cookie, which the env jar carries when present.
const CDP_OPTIONS = {
  domain: DOMAIN,
  cookieName: SESSION_COOKIE,
  exactName: true,
} as const;

/** Top-level grant fields; the response's nested `grants` history is ignored. */
const GrantSchema = z.object({
  packageName: z.string().min(1),
  totalUsd: z.string(),
  remainingUsd: z.string(),
  expiresAt: z.string().min(1),
});

type Grant = z.infer<typeof GrantSchema>;

/** The RPC wraps the current grant in a `json` envelope: `{"json":{…grant…}}`. */
const GrantEnvelopeSchema = z.object({ json: GrantSchema });

/** Round a number to 2 decimal places (for dollar amounts). */
const round2 = (n: number): number => Math.round(n * ROUND_SCALE) / ROUND_SCALE;

/** Parse a decimal dollar string into a finite number, or null when malformed. */
function parseUsd(value: string): number | null {
  const trimmed = value.trim();

  // Number('') is 0, which would read as a fully spent package instead of a
  // malformed payload.
  if (trimmed === '') {
    return null;
  }

  const amount = Number(trimmed);

  return Number.isFinite(amount) ? amount : null;
}

/** Build the `name=value; name=value` jar pushed into Chrome from env values. */
function envCookieString(token: string, clearance?: string): string {
  const cookies = [`${SESSION_COOKIE}=${token}`];

  if (clearance) {
    cookies.push(`${CF_CLEARANCE_COOKIE}=${clearance}`);
  }

  return cookies.join(COOKIE_SEPARATOR);
}

/**
 * Build the provider card from one grant envelope. Exported so the window math
 * is testable without a browser: `used` is the dollars consumed inside the
 * monthly package period (startsAt → expiresAt), and remaining is clamped
 * because a mid-cycle top-up can push it above the period total while an
 * overage pushes it below zero — and UsageWindow rejects used > total.
 */
export function buildGrantProvider(grant: Grant): Provider {
  const total = parseUsd(grant.totalUsd);
  const remaining = parseUsd(grant.remainingUsd);

  if (total == null || total <= 0 || remaining == null) {
    throw new Error(SESSION_EXPIRED_MSG);
  }

  const left = round2(Math.min(Math.max(remaining, 0), total));
  const used = round2(total - left);

  const window = UsageWindow.fromCounts(
    MONTHLY_LABEL,
    used,
    total,
    grant.expiresAt,
    `$${left.toFixed(2)} left`,
  );

  return Provider.fromAdapter(ID, NAME, grant.packageName, [window], grant.packageName);
}

export class R4 implements ProviderAdapter {
  readonly id = ID;
  readonly name = NAME;

  async fetchUsage(): Promise<Provider> {
    if (!(await this.ensureCookies())) {
      return Provider.notConfigured(this.id, this.name, NOT_CONFIGURED_MSG);
    }

    const navigation = await navigateViaBrowser(DASHBOARD_URL);

    if (!navigation.ok) {
      throw new Error(`R4 dashboard navigation failed: ${navigation.error ?? 'unknown error'}`);
    }

    const grant = await this.fetchGrant();

    return buildGrantProvider(grant);
  }

  /**
   * Make sure the user's Chrome holds the r4.codes session cookie. The live CDP
   * jar wins; when it has no session (fresh Chrome profile or recreated
   * container), the env-provided cookie is pushed back into Chrome and the
   * dashboard tab picks it up. Without either source the adapter has no way to
   * authenticate at all.
   */
  private async ensureCookies(): Promise<boolean> {
    const live = await refreshCookiesViaBrowser(CDP_OPTIONS);

    if (live.ok && live.cookieString) {
      return true;
    }

    if (!config.R4_SESSION_TOKEN) {
      return false;
    }

    const restored = await restoreCookiesViaBrowser(
      envCookieString(config.R4_SESSION_TOKEN, config.R4_CF_CLEARANCE),
      DOMAIN,
    );

    if (restored) {
      log.info('R4 cookies restored into Chrome from R4_SESSION_TOKEN');
    }

    // A failed restore still proceeds: the navigation or the RPC then reports
    // the real problem (Chrome down, rejected cookie) instead of a config hint.
    return true;
  }

  /** Read the grant body from the dashboard origin and validate its shape. */
  private async fetchGrant(): Promise<Grant> {
    const raw = await evaluateInPage(GRANT_EXPRESSION);

    if (typeof raw !== 'string') {
      throw new Error(SESSION_EXPIRED_MSG);
    }

    let payload: unknown;

    try {
      payload = JSON.parse(raw);
    } catch {
      // A Cloudflare challenge or the login page arrives as HTML, not JSON.
      log.debug('R4 grant response is not JSON — login page or Cloudflare challenge');

      throw new Error(SESSION_EXPIRED_MSG);
    }

    const envelope = GrantEnvelopeSchema.safeParse(payload);

    if (!envelope.success) {
      throw new Error(SESSION_EXPIRED_MSG);
    }

    return envelope.data.json;
  }
}
