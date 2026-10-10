import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  navigateViaBrowser,
  parseCookiePairs,
  refreshCookiesViaBrowser,
  restoreCookiesViaBrowser,
} from '../browser-cookies.js';
import { config } from '../config.js';
import { CHROME_USER_AGENT, MS_PER_HOUR, MS_PER_MINUTE } from '../constants.js';
import { readDataFile, writeDataFile } from '../data-file.js';
import { fetchJsonWith, fetchText, postFormJson } from '../fetch-utils.js';
import { createLogger } from '../logger.js';
import { Provider } from '../provider.js';
import { msToIso } from '../time-utils.js';
import type { ProviderAdapter } from '../types.js';
import { UsageWindow } from '../usage-window.js';

const log = createLogger('adapter:alibaba-qwen');

const CONSOLE_HOST = 'modelstudio.console.alibabacloud.com';
const MODELSTUDIO_ORIGIN = `https://${CONSOLE_HOST}`;
const CONSOLE_ROOT_URL = `${MODELSTUDIO_ORIGIN}/ap-southeast-1`;
// Personal Token Plan dashboard: OneConsole server-renders SEC_TOKEN into this
// page, so the HTML fetch targets it (not just the region root) with the same
// same-origin navigation headers a real browser sends.
const PAGE_URL = `${CONSOLE_ROOT_URL}/tokenPlan`;
// The console shell stopped redirecting anonymous visitors through SSO, so a
// plain navigation to PAGE_URL no longer runs the silent SSO chain. The
// console's own Log In button targets this account endpoint, which still does
// the re-mint server-side while the long-lived havana TGC is alive.
const SSO_LOGIN_URL = `https://account.alibabacloud.com/login/login.htm?oauth_callback=${encodeURIComponent(PAGE_URL)}&clearRedirectCookie=1`;
const USER_INFO_URL = `${MODELSTUDIO_ORIGIN}/tool/user/info.json`;
const GATEWAY_URL = 'https://bailian-singapore-cs.alibabacloud.com/data/api.json';
const GATEWAY_ACTION = 'IntlBroadScopeAspnGateway';
const GATEWAY_PRODUCT = 'sfm_bailian';
const USAGE_API = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage';
const REGION = 'ap-southeast-1';
const PERCENT_MAX = 100;
const PERCENT_SCALE = 100;

// ModelStudio endpoints measured 5–10.3s from this host, so the shared 10s
// budget aborted healthy requests into spurious timeout errors; this adapter
// uses a 30s budget instead (refresh ticks run adapters in parallel and
// tolerate the longer bound).
const QWEN_FETCH_TIMEOUT_MS = 30_000;

// Transient host-network blips (DNS failure, refused or reset connection)
// get exactly one quick second chance inside the same refresh tick.
const NETWORK_RETRY_DELAY_MS = 1_500;

// The console HTML has embedded SEC_TOKEN as `SEC_TOKEN: "…"`, `SEC_TOKEN = '…'`,
// camelCase `"secToken": "…"`, and snake_case `sec_token = "…"` across shell
// revisions. Every spelling is tried in both quote styles so a revision does
// not silently drop the CSRF token. Best-effort: a missing token no longer
// blocks the gateway call.
const SEC_TOKEN_RES = [
  /\bSEC_TOKEN\b\s*[:=]\s*['"]([^'"]+)['"]/,
  /\bsecToken\b\s*[:=]\s*['"]([^'"]+)['"]/,
  /\bsec_token\b\s*[:=]\s*['"]([^'"]+)['"]/i,
];
const SEC_TOKEN_COOKIE_RE = /(?:^|;\s*)sec_token=([^;]+)/i;

const COOKIE_FILE = 'data/alibaba-qwen-cookies.txt';
const COOKIE_FILE_LABEL = 'Alibaba Qwen cookies';
const CDP_HINT = 'google-chrome --remote-debugging-port=9222';

const NOT_CONFIGURED_MSG =
  'Start Chrome with --remote-debugging-port=9222 and log into modelstudio.console.alibabacloud.com, or set ALIBABA_QWEN_COOKIE';

// The havana login ticket is the load-bearing cookie of the console session.
const CDP_OPTIONS = {
  domain: 'alibabacloud.com',
  cookieName: 'login_aliyunid_ticket',
  exactName: true,
} as const;

// browser-cookies reports a missing console login with this text; combined
// with a persisted jar that still carries the long-lived havana_tgc SSO
// ticket it means Chrome itself lost its profile — the jar can be pushed back.
const NO_TICKET_ERROR = `No ${CDP_OPTIONS.cookieName} cookie found`;
const HAVANA_TGC_COOKIE = 'havana_tgc=';

// The logged-out gateway answers HTTP 200 with a flat envelope that has no
// DataV2 payload, e.g. errorCode "BailianGateway.Login.NotLogined".
const GatewayErrorSchema = z.object({
  data: z.object({
    errorCode: z.string().optional(),
    errorMsg: z.string().optional(),
  }),
});

// The user-info endpoint is a login probe that may carry the token when the
// session is alive; both locations are checked, absence yields null.
const UserInfoSchema = z.object({
  code: z.string().optional(),
  secToken: z.string().optional(),
  data: z.object({ secToken: z.string().optional() }).optional(),
});

type UserInfo = z.infer<typeof UserInfoSchema>;

// Tri-state login probe outcome: only 'logged-out' is evidence of a dead
// session; 'unknown' (probe failed) must keep the previous cookies and never
// start the CDP cooldown.
type SessionProbe = 'alive' | 'logged-out' | 'unknown';

// Outcome of one CDP cookie refresh; drives the caller's cooldown and retry:
// only 'logged-out' starts the cooldown, 'unavailable' must not, because CDP
// itself may come back on any tick while Chrome is being restarted.
type CdpRefreshOutcome = 'refreshed' | 'logged-out' | 'unavailable';

// Right after the weekly rollover the gateway answers with
// per1WeekPercentage: 0 and omits per1WeekResetTime entirely, so the reset
// time is optional: a required number rejected that payload and left the
// stale pre-reset usage visible.
interface QwenUsageData {
  per1WeekResetTime?: number | null;
  per1WeekPercentage: number;
}

const UsageDataSchema = z.object({
  per1WeekResetTime: z.number().nullish(),
  per1WeekPercentage: z.number(),
});

/** Gateway envelope: the API payload sits at data.DataV2.data.data. */
const GatewayEnvelopeSchema = z.object({
  successResponse: z.boolean(),
  data: z.object({
    DataV2: z.object({
      data: z.object({
        code: z.string(),
        msg: z.string(),
        success: z.boolean(),
        data: z.unknown(),
      }),
    }),
  }),
});

// Cookie state — persisted to disk so it survives server restarts
let storedCookies: string | null = null;

// CDP cooldown: started only when a CDP attempt produced cookies the login
// probe rejected, so a known-dead session is not re-extracted every tick.
// Gateway failures alone never extend it — the timestamp always expires and
// CDP is retried, while the cheap gateway probe itself keeps running and
// auto-recovers on login.
let cdpCooldownUntil = 0;

// Silent-SSO keepalive timer — mirrors the Context7 pattern: a module-level
// timer (re)scheduled after every fetch and every keepalive run.
let keepaliveTimer: ReturnType<typeof setTimeout> | null = null;

const LOGIN_COOLDOWN_MINUTES = 10;
const LOGIN_COOLDOWN_MS = LOGIN_COOLDOWN_MINUTES * MS_PER_MINUTE;

// Gateway error codes that mean the console login itself is gone.
const LOGIN_REQUIRED_RE = /NotLogined|ConsoleNeedLogin/i;

// user-info success spellings; any other `code` means the session is logged out.
const USER_INFO_OK_CODES = new Set(['0', '200']);

const SESSION_EXPIRED_MSG = `Console session expired — open ${config.CHROME_UI_URL} and log in at ${CONSOLE_HOST}`;

const SILENT_REFRESH_FAILED_MSG =
  'Alibaba Qwen silent SSO refresh failed — the havana TGC cookies are likely expired; leaving the session to the normal fetch flow';

/* ── Network retry ──────────────────────────────────────── */

/**
 * Retry one async HTTP call exactly once on a network-level failure.
 *
 * undici surfaces host-level outages (DNS, connection refused or reset) as
 * `TypeError: fetch failed`, so only a TypeError earns one retry after a
 * short delay — exactly one, because a second consecutive blip means the
 * host network is down and the next refresh tick should see it fresh.
 * Everything else is an answer, not an outage: a `TimeoutError` means the
 * endpoint said "no" within its time budget, and the plain
 * `Error("HTTP <status>")` from fetch-utils is an application-level
 * response; retrying either would just duplicate the request.
 *
 * When the retry also fails at the network level, the TypeError is rethrown
 * as a plain `Error("fetch failed (<cause code>)")` so log lines stay
 * diagnostic; the original error travels in `cause`, and TypeError-ness
 * stays irrelevant to callers, which match on message text only.
 */
export async function withNetworkRetry<T>(
  op: () => Promise<T>,
  delayMs: number = NETWORK_RETRY_DELAY_MS,
): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (!(err instanceof TypeError)) {
      throw err;
    }

    log.debug({ delayMs }, 'Alibaba Qwen fetch failed with TypeError, retrying once');

    await new Promise((resolve) => setTimeout(resolve, delayMs));

    try {
      return await op();
    } catch (retryErr) {
      if (!(retryErr instanceof TypeError)) {
        throw retryErr;
      }

      const cause = retryErr.cause as { code?: string } | undefined;
      const causeCode = cause?.code ?? 'network error';

      throw new Error(`fetch failed (${causeCode})`, { cause: retryErr });
    }
  }
}

/* ── Cookie helpers ─────────────────────────────────────── */

function loadCookies(): string | null {
  return readDataFile(COOKIE_FILE, config.ALIBABA_QWEN_COOKIE);
}

function saveCookies(cookies: string): void {
  writeDataFile(COOKIE_FILE, cookies, COOKIE_FILE_LABEL);
}

/** Extract the error code from the flat envelope a logged-out session gets. */
function flatGatewayError(raw: unknown): string {
  const error = GatewayErrorSchema.safeParse(raw);

  if (error.success) {
    return error.data.data.errorCode ?? error.data.data.errorMsg ?? 'unexpected response';
  }

  return 'unexpected response';
}

/** True when an error means the console session is logged out. */
function isLoginRequired(err: unknown): boolean {
  return err instanceof Error && LOGIN_REQUIRED_RE.test(err.message);
}

/** Pull the SEC token out of the console HTML using every known spelling. */
function extractSecTokenFromHtml(html: string): string | null {
  for (const re of SEC_TOKEN_RES) {
    const token = re.exec(html)?.[1];

    if (token) {
      return token;
    }
  }

  return null;
}

/* ── Session probe ──────────────────────────────────────── */

async function fetchUserInfo(cookie: string): Promise<UserInfo> {
  const raw = await withNetworkRetry(() =>
    fetchJsonWith(
      USER_INFO_URL,
      {
        accept: 'application/json, text/plain, */*',
        cookie,
        referer: `${PAGE_URL}/`,
        'user-agent': CHROME_USER_AGENT,
      },
      QWEN_FETCH_TIMEOUT_MS,
    ),
  );

  return UserInfoSchema.parse(raw);
}

/**
 * Cheap login probe: a non-success `code` means the cookies are logged out,
 * while a failed probe (network/timeout/parse) is 'unknown' — it says nothing
 * about the login and must never be treated as a dead session.
 */
async function probeSession(cookie: string): Promise<SessionProbe> {
  try {
    const info = await fetchUserInfo(cookie);

    if (info.code == null || USER_INFO_OK_CODES.has(info.code)) {
      return 'alive';
    }

    return 'logged-out';
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err : new Error(String(err)) },
      'Alibaba Qwen login probe failed',
    );

    return 'unknown';
  }
}

/* ── Keepalive ──────────────────────────────────────────── */

/**
 * Silent-SSO keepalive: navigate a real browser tab to the account re-login
 * endpoint so the long-lived havana TGC cookies re-mint the short-lived login
 * ticket, then re-extract and validate the cookie jar via CDP. Never touches
 * the CDP cooldown: a failed silent refresh leaves everything to the fetch
 * flow.
 */
async function keepalive(): Promise<void> {
  if (!storedCookies) {
    return; // Nothing to maintain — do not spam CDP with navigations.
  }

  try {
    const navigation = await navigateViaBrowser(SSO_LOGIN_URL);

    if (!navigation.ok) {
      log.warn({ reason: navigation.error }, 'Alibaba Qwen keepalive: navigation failed');

      return;
    }

    const result = await refreshCookiesViaBrowser(CDP_OPTIONS);

    if (!(result.ok && result.cookieString)) {
      log.warn(SILENT_REFRESH_FAILED_MSG);

      return;
    }

    const probe = await probeSession(result.cookieString);

    if (probe === 'unknown') {
      log.warn('Alibaba Qwen keepalive: login probe unavailable — keeping the previous session');

      return;
    }

    if (probe === 'logged-out') {
      log.warn(SILENT_REFRESH_FAILED_MSG);

      return;
    }

    storedCookies = result.cookieString;
    saveCookies(storedCookies);
    log.info('Alibaba Qwen session kept alive via silent SSO refresh');
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err : new Error(String(err)) },
      'Alibaba Qwen keepalive failed',
    );
  }
}

/** (Re)schedule the next keepalive run; a 0-hour interval disables it. */
function scheduleKeepalive(): void {
  const intervalMs = config.ALIBABA_QWEN_KEEPALIVE_HOURS * MS_PER_HOUR;

  if (keepaliveTimer || intervalMs <= 0) {
    return;
  }

  keepaliveTimer = setTimeout(() => {
    keepaliveTimer = null;
    keepalive()
      .catch(() => {
        /* failures are already logged inside keepalive */
      })
      .finally(() => {
        scheduleKeepalive();
      });
  }, intervalMs);
}

/* ── Adapter ────────────────────────────────────────────── */

export class AlibabaQwen implements ProviderAdapter {
  id = 'alibaba-qwen';
  name = 'Alibaba Qwen';

  async fetchUsage(): Promise<Provider> {
    try {
      return await this.fetchUsageInner();
    } finally {
      // Both outcomes (re)schedule the silent-SSO keepalive; scheduling must
      // never affect the fetch result.
      scheduleKeepalive();
    }
  }

  // Pause the silent-SSO timer while archived; the next fetchUsage reschedules it.
  stopKeepalive(): void {
    if (keepaliveTimer) {
      clearTimeout(keepaliveTimer);
      keepaliveTimer = null;
    }
  }

  private async fetchUsageInner(): Promise<Provider> {
    if (!storedCookies) {
      storedCookies = loadCookies();
    }

    // Bootstrap via CDP when no persisted/env cookies are available
    if (!storedCookies) {
      await this.bootstrapViaBrowser();
    }

    if (!storedCookies) {
      return Provider.notConfigured(this.id, this.name, NOT_CONFIGURED_MSG);
    }

    try {
      return await this.fetchProvider(storedCookies);
    } catch (err) {
      // The session likely expired — try one CDP refresh whose cookies are
      // validated against the login probe. The cooldown is started only by
      // an actual rejected CDP attempt, never by the gateway error itself:
      // otherwise every failing tick would re-extend it and CDP would never
      // be retried, even after the user logs back into Chrome.
      if (await this.recoverViaBrowser()) {
        return await this.fetchProvider(storedCookies);
      }

      throw isLoginRequired(err) ? new Error(SESSION_EXPIRED_MSG) : err;
    }
  }

  /**
   * Gated CDP recovery for a failed fetch: attempted only outside the
   * cooldown window. Returns true when fresh cookies were saved and the
   * caller should retry the fetch; starts the cooldown only when the
   * extracted cookies were rejected by the login probe, so the window
   * always expires and CDP is retried even after repeated failures.
   */
  private async recoverViaBrowser(): Promise<boolean> {
    if (Date.now() < cdpCooldownUntil) {
      return false;
    }

    const outcome = await this.refreshViaBrowser();

    if (outcome === 'refreshed') {
      return true;
    }

    if (outcome === 'logged-out') {
      // Chrome holds a dead login: back off for the whole window so the dead
      // session is not re-extracted every tick. The cheap gateway probe
      // keeps running and auto-recovers once the user logs in.
      cdpCooldownUntil = Date.now() + LOGIN_COOLDOWN_MS;
    }

    // 'unavailable' deliberately starts no cooldown: CDP itself failed (e.g.
    // Chrome is closed) or the login probe could not run, so the next tick
    // retries both as soon as they are back.
    return false;
  }

  private async fetchProvider(cookies: string): Promise<Provider> {
    // Best-effort: a missing token must not block the personal-plan gateway.
    const secToken = await this.resolveSecToken(cookies);
    const usage = await this.fetchUsageData(cookies, secToken);
    const windows = buildWeekWindows(usage);

    return new Provider(this.id, this.name, 'Token Plan', [{ modelName: 'Token Plan', windows }]);
  }

  private async bootstrapViaBrowser(): Promise<void> {
    const result = await refreshCookiesViaBrowser(CDP_OPTIONS);

    if (!(result.ok && result.cookieString)) {
      return;
    }

    storedCookies = result.cookieString;
    saveCookies(storedCookies);
    log.info({ mode: result.mode }, 'Alibaba Qwen session bootstrapped');
  }

  /**
   * Attempt to recover an expired session by extracting fresh cookies from Chrome via CDP.
   *
   * Returns 'refreshed' when cookies were extracted and validated by the login
   * probe, 'logged-out' when Chrome holds a session the probe rejected, and
   * 'unavailable' when CDP itself failed or the probe could not run (neither
   * case starts the cooldown). A probe rejection triggers one silent-SSO
   * re-mint through the account re-login endpoint before 'logged-out' is
   * returned.
   */
  private async refreshViaBrowser(): Promise<CdpRefreshOutcome> {
    const result = await refreshCookiesViaBrowser(CDP_OPTIONS);

    if (result.ok && result.cookieString) {
      const outcome = await this.probeAndStore(result.cookieString, result.mode);

      if (outcome !== 'logged-out') {
        return outcome;
      }

      const ssoOutcome = await this.ssoReExtract();

      if (ssoOutcome === 'refreshed') {
        return 'refreshed';
      }

      return 'logged-out';
    }

    if (result.error?.includes('Chrome not found')) {
      log.warn(`CDP unavailable — using cached data. Start Chrome with: ${CDP_HINT}`);
    }

    // Chrome holds no login ticket but the persisted jar still carries the
    // havana_tgc SSO cookie: the container lost its profile, so push the jar
    // back in and let silent SSO re-mint the ticket — one attempt per call.
    if (result.error?.includes(NO_TICKET_ERROR) && storedCookies?.includes(HAVANA_TGC_COOKIE)) {
      const outcome = await this.restoreSession(storedCookies);

      if (outcome) {
        return outcome;
      }
    }

    return 'unavailable';
  }

  /**
   * Validate extracted cookies with the login probe and store them only when
   * alive. Chrome may hold a dead login: trusting it unchecked would retry
   * the gateway with the same stale session in a loop. An 'unknown' probe
   * (network/timeout) is not evidence of a dead login, so the fresh cookies
   * are discarded without starting the cooldown — CDP is simply retried on
   * the next tick.
   */
  private async probeAndStore(cookieString: string, mode: string): Promise<CdpRefreshOutcome> {
    const probe = await probeSession(cookieString);

    if (probe === 'logged-out') {
      log.warn('CDP cookies rejected — console session is logged out');

      return 'logged-out';
    }

    if (probe === 'unknown') {
      log.warn('CDP cookie validation unavailable — login probe failed');

      return 'unavailable';
    }

    storedCookies = cookieString;
    saveCookies(storedCookies);
    log.info({ mode }, 'Alibaba Qwen session refreshed');

    return 'refreshed';
  }

  /**
   * One silent-SSO re-mint attempt through the account re-login endpoint: the
   * console's own Log In target still runs the SSO chain server-side, so a
   * navigation there lets a live havana TGC mint a fresh login ticket, which
   * the normal probe then validates. Returns null when the navigation or the
   * re-extraction fails — the caller keeps its current outcome.
   */
  private async ssoReExtract(): Promise<CdpRefreshOutcome | null> {
    const navigation = await navigateViaBrowser(SSO_LOGIN_URL);

    if (!navigation.ok) {
      log.warn({ reason: navigation.error }, 'Alibaba Qwen SSO re-login: navigation failed');

      return null;
    }

    const result = await refreshCookiesViaBrowser(CDP_OPTIONS);

    if (!(result.ok && result.cookieString)) {
      log.warn({ reason: result.error }, 'Alibaba Qwen SSO re-login: re-extract failed');

      return null;
    }

    return await this.probeAndStore(result.cookieString, result.mode);
  }

  /**
   * One recovery attempt after Chrome lost its profile: push the persisted
   * cookie jar back in via CDP, navigate to the SSO re-login endpoint so
   * silent SSO re-mints the login ticket from havana_tgc, then re-extract and
   * run the normal probe on the fresh result. Returns null when recovery did
   * not produce a probeable outcome — the caller then stays 'unavailable'.
   */
  private async restoreSession(cookies: string): Promise<CdpRefreshOutcome | null> {
    const restored = await restoreCookiesViaBrowser(cookies, CDP_OPTIONS.domain);

    if (!restored) {
      log.warn('Alibaba Qwen: cookie restore into Chrome failed');

      return null;
    }

    log.info(
      { count: parseCookiePairs(cookies).length },
      'Alibaba Qwen: restored cookies into Chrome via CDP',
    );

    const navigation = await navigateViaBrowser(SSO_LOGIN_URL);

    if (!navigation.ok) {
      log.warn({ reason: navigation.error }, 'Alibaba Qwen: restore navigation failed');

      return null;
    }

    const retry = await refreshCookiesViaBrowser(CDP_OPTIONS);

    if (retry.ok && retry.cookieString) {
      return await this.probeAndStore(retry.cookieString, retry.mode);
    }

    log.warn({ reason: retry.error }, 'Alibaba Qwen: restore re-extract failed');

    return null;
  }

  /**
   * Best-effort SEC token for the gateway form (CSRF, not auth).
   *
   * Each source is tried independently: an HTML fetch failure must not skip a
   * valid sec_token cookie or the user-info fallback. Returns null when nothing
   * yields a token — the gateway then gets a cookie-only request and reports
   * the authoritative auth error itself. Failures are nonfatal and logged
   * without the token or cookie values.
   */
  private async resolveSecToken(cookie: string): Promise<string | null> {
    const htmlToken = await this.bestEffortToken('console HTML', async () => {
      const html = await this.fetchConsoleHtml(cookie);

      return extractSecTokenFromHtml(html);
    });

    if (htmlToken) {
      return htmlToken;
    }

    const fromCookie = SEC_TOKEN_COOKIE_RE.exec(cookie)?.[1];

    if (fromCookie) {
      return fromCookie;
    }

    return await this.bestEffortToken('user-info', () => this.fetchSecTokenFromUserInfo(cookie));
  }

  /** Run one SEC-token source, swallowing failures so it cannot mask the others. */
  private async bestEffortToken(
    label: string,
    source: () => Promise<string | null>,
  ): Promise<string | null> {
    try {
      return await source();
    } catch (err) {
      log.warn(
        { source: label, err: err instanceof Error ? err : new Error(String(err)) },
        'SEC token source unavailable',
      );

      return null;
    }
  }

  private async fetchConsoleHtml(cookie: string): Promise<string> {
    // Same-origin document navigation: OneConsole server-renders SEC_TOKEN only
    // for requests that look like a real browser navigating to the dashboard,
    // so send the Sec-Fetch-* navigation headers and a same-origin Referer.
    return await withNetworkRetry(() =>
      fetchText(
        PAGE_URL,
        {
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
          cookie,
          referer: CONSOLE_ROOT_URL,
          'sec-fetch-dest': 'document',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-site': 'same-origin',
          'user-agent': CHROME_USER_AGENT,
        },
        QWEN_FETCH_TIMEOUT_MS,
      ),
    );
  }

  private async fetchSecTokenFromUserInfo(cookie: string): Promise<string | null> {
    const info = await fetchUserInfo(cookie);

    return info.secToken ?? info.data?.secToken ?? null;
  }

  private async fetchUsageData(cookie: string, secToken: string | null): Promise<QwenUsageData> {
    const params = {
      Api: USAGE_API,
      V: '1.0',
      Data: {
        cornerstoneParam: {
          feTraceId: randomUUID(),
          feURL: PAGE_URL,
          protocol: 'V2',
          console: 'ONE_CONSOLE',
          productCode: 'p_efm',
          domain: 'modelstudio.console.alibabacloud.com',
          consoleSite: 'MODELSTUDIO_ALBABACLOUD',
          xsp_lang: 'en-US',
        },
      },
    };

    // sec_token is CSRF, not authentication: omit it entirely when unresolved
    // so the personal-plan gateway still receives a valid cookie-only request.
    const form: Record<string, string> = {
      params: JSON.stringify(params),
      region: REGION,
    };

    if (secToken) {
      form.sec_token = secToken;
    }

    const body = new URLSearchParams(form);

    const headers = {
      accept: 'application/json, text/plain, */*',
      cookie,
      origin: MODELSTUDIO_ORIGIN,
      referer: PAGE_URL,
      'user-agent': CHROME_USER_AGENT,
    };

    const url = `${GATEWAY_URL}?action=${GATEWAY_ACTION}&product=${GATEWAY_PRODUCT}&api=${USAGE_API}&_v=undefined`;

    const raw = await withNetworkRetry(() =>
      postFormJson(url, headers, body, QWEN_FETCH_TIMEOUT_MS),
    );
    const envelope = GatewayEnvelopeSchema.safeParse(raw);

    if (!envelope.success) {
      throw new Error(`Token plan gateway error: ${flatGatewayError(raw)}`);
    }

    const result = envelope.data.data.DataV2.data;

    if (!(envelope.data.successResponse && result.success)) {
      throw new Error(`Token plan gateway error: ${result.msg}`);
    }

    return UsageDataSchema.parse(result.data);
  }
}

/** Convert the gateway usage payload into the weekly window with its reset timestamp. */
export function buildWeekWindows(usage: QwenUsageData): UsageWindow[] {
  const rawPercent = usage.per1WeekPercentage * PERCENT_SCALE;
  const usedPercent = Math.min(PERCENT_MAX, Math.max(0, Math.round(rawPercent * 10) / 10));

  // The post-rollover payload has no reset time; null keeps the fresh zero
  // visible instead of the fetch failing and serving stale cached data.
  const resetAt = usage.per1WeekResetTime == null ? null : msToIso(usage.per1WeekResetTime);

  return [UsageWindow.fromApi('weekly', usedPercent, resetAt)];
}
