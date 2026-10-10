import { beforeEach, describe, expect, it, vi } from 'vitest';

const refreshCookiesViaBrowser = vi.hoisted(() => vi.fn());
const restoreCookiesViaBrowser = vi.hoisted(() => vi.fn());
const navigateViaBrowser = vi.hoisted(() => vi.fn());
const evaluateInPage = vi.hoisted(() => vi.fn());
const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({ createLogger: () => logger }));

const configRef = vi.hoisted(() => ({
  sessionToken: undefined as string | undefined,
  cfClearance: undefined as string | undefined,
}));

vi.mock('../../src/browser-cookies.js', () => ({
  refreshCookiesViaBrowser,
  restoreCookiesViaBrowser,
  navigateViaBrowser,
  evaluateInPage,
}));

vi.mock('../../src/config.js', () => ({
  config: {
    get R4_SESSION_TOKEN(): string | undefined {
      return configRef.sessionToken;
    },
    get R4_CF_CLEARANCE(): string | undefined {
      return configRef.cfClearance;
    },
  },
}));

import { buildGrantProvider, R4 } from '../../src/adapters/r4.js';

// Live getGrant sample (2026-09-20): money arrives as decimal strings and the
// package runs one month from startsAt to expiresAt.
const GRANT_SAMPLE = {
  packageName: 'Code Lite',
  remainingUsd: '55.711911',
  totalUsd: '60.000000',
  maxConcurrency: 6,
  startsAt: '2026-09-20T14:31:21.167Z',
  expiresAt: '2026-10-20T14:31:21.167Z',
};

/** Full RPC body: the current grant sits at the top level under `json`. */
const GRANT_BODY = { json: GRANT_SAMPLE, meta: { isCached: false }, grants: [] };

const DASHBOARD_URL = 'https://r4.codes/dashboard/overview';
const GRANT_URL = 'https://api.r4.codes/rpc/billing/getGrant';
const DOMAIN = 'r4.codes';

const SESSION_EXPIRED =
  'R4 session expired — log into r4.codes in the Chrome UI and re-set R4_SESSION_TOKEN';

const CDP_OPTIONS = {
  domain: DOMAIN,
  cookieName: '__Secure-better-auth.session_token',
  exactName: true,
} as const;

const CDP_SUCCESS = {
  ok: true,
  cookieString: `${CDP_OPTIONS.cookieName}=live-token`,
  mode: 'cdp',
} as const;

const CDP_FAILURE = {
  ok: false,
  cookieString: null,
  mode: 'cdp',
  error: `No ${CDP_OPTIONS.cookieName} cookie found`,
} as const;

const NAVIGATION_OK = { ok: true } as const;

const ENV_TOKEN = 'env-token';
const ENV_CLEARANCE = 'cf-clearance-value';

const TOTAL_USD = 60;
const USED_USD = 4.29;
const USED_PERCENT = 7.2;
const REMAINING_PERCENT = 92.8;
const EXPIRES_AT = '2026-10-20T14:31:21.167Z';
const REMAINING_LABEL = '$55.71 left';

const SMALL_TOTAL_USD = 10;
const TOP_UP_REMAINING_USD = '12.500000';
const OVERDRAWN_REMAINING_USD = '-2.000000';
const TOP_UP_LABEL = '$10.00 left';
const OVERDRAWN_LABEL = '$0.00 left';
const FULL_PERCENT = 100;

const SINGLE_WINDOW = 1;

describe('buildGrantProvider', () => {
  it('builds the monthly window from the live decimal-string sample', () => {
    const provider = buildGrantProvider(GRANT_SAMPLE);

    expect(provider.id).toBe('r4');
    expect(provider.name).toBe('R4 Coder');
    expect(provider.plan).toBe('Code Lite');
    expect(provider.models).toHaveLength(SINGLE_WINDOW);
    expect(provider.models[0].modelName).toBe('Code Lite');

    const [win] = provider.models[0].windows;

    expect(win.label).toBe('monthly');
    expect(win.used).toBe(USED_USD);
    expect(win.total).toBe(TOTAL_USD);
    expect(win.usedPercent).toBe(USED_PERCENT);
    expect(win.remainingPercent).toBe(REMAINING_PERCENT);
    expect(win.resetAt).toBe(EXPIRES_AT);
    expect(win.valueLabel).toBe(REMAINING_LABEL);
  });

  it('clamps a top-up that pushes remaining above the period total', () => {
    const provider = buildGrantProvider({
      ...GRANT_SAMPLE,
      totalUsd: `${SMALL_TOTAL_USD}.000000`,
      remainingUsd: TOP_UP_REMAINING_USD,
    });

    const [win] = provider.models[0].windows;

    expect(win.used).toBe(0);
    expect(win.total).toBe(SMALL_TOTAL_USD);
    expect(win.usedPercent).toBe(0);
    expect(win.valueLabel).toBe(TOP_UP_LABEL);
  });

  it('clamps an overdrawn remaining amount to a fully used window', () => {
    const provider = buildGrantProvider({
      ...GRANT_SAMPLE,
      totalUsd: `${SMALL_TOTAL_USD}.000000`,
      remainingUsd: OVERDRAWN_REMAINING_USD,
    });

    const [win] = provider.models[0].windows;

    expect(win.used).toBe(SMALL_TOTAL_USD);
    expect(win.usedPercent).toBe(FULL_PERCENT);
    expect(win.valueLabel).toBe(OVERDRAWN_LABEL);
  });

  it('throws the session-expired error on malformed dollar amounts', () => {
    expect(() => buildGrantProvider({ ...GRANT_SAMPLE, totalUsd: 'not-a-number' })).toThrow(
      SESSION_EXPIRED,
    );
    expect(() => buildGrantProvider({ ...GRANT_SAMPLE, totalUsd: '0.000000' })).toThrow(
      SESSION_EXPIRED,
    );
    expect(() => buildGrantProvider({ ...GRANT_SAMPLE, remainingUsd: '' })).toThrow(
      SESSION_EXPIRED,
    );
  });
});

describe('R4.fetchUsage', () => {
  beforeEach(() => {
    configRef.sessionToken = undefined;
    configRef.cfClearance = undefined;
    refreshCookiesViaBrowser.mockReset().mockResolvedValue(CDP_SUCCESS);
    restoreCookiesViaBrowser.mockReset().mockResolvedValue(true);
    navigateViaBrowser.mockReset().mockResolvedValue(NAVIGATION_OK);
    evaluateInPage.mockReset().mockResolvedValue(JSON.stringify(GRANT_BODY));
    logger.info.mockReset();
  });

  it('returns the not-configured card when neither Chrome nor the env has a session', async () => {
    refreshCookiesViaBrowser.mockResolvedValue(CDP_FAILURE);

    const provider = await new R4().fetchUsage();

    expect(refreshCookiesViaBrowser).toHaveBeenCalledWith(CDP_OPTIONS);
    expect(provider.plan).toBe('Not configured');
    expect(provider.error).toMatch(/log ?in/i);
    expect(restoreCookiesViaBrowser).not.toHaveBeenCalled();
    expect(navigateViaBrowser).not.toHaveBeenCalled();
    expect(evaluateInPage).not.toHaveBeenCalled();
  });

  it('reads the grant through the dashboard tab when Chrome holds the session', async () => {
    const provider = await new R4().fetchUsage();

    expect(restoreCookiesViaBrowser).not.toHaveBeenCalled();
    expect(navigateViaBrowser).toHaveBeenCalledWith(DASHBOARD_URL);
    expect(evaluateInPage).toHaveBeenCalledTimes(SINGLE_WINDOW);

    const [expression] = evaluateInPage.mock.calls[0] as [string];

    expect(expression).toContain(GRANT_URL);
    expect(expression).toContain("method:'POST'");
    expect(expression).toContain("credentials:'include'");
    expect(provider.error).toBeUndefined();
    expect(provider.plan).toBe('Code Lite');
    expect(provider.models[0].windows[0].valueLabel).toBe(REMAINING_LABEL);
  });

  it('restores the env cookie jar into Chrome when CDP has no session', async () => {
    refreshCookiesViaBrowser.mockResolvedValue(CDP_FAILURE);
    configRef.sessionToken = ENV_TOKEN;
    configRef.cfClearance = ENV_CLEARANCE;

    const provider = await new R4().fetchUsage();

    expect(restoreCookiesViaBrowser).toHaveBeenCalledWith(
      `${CDP_OPTIONS.cookieName}=${ENV_TOKEN}; cf_clearance=${ENV_CLEARANCE}`,
      DOMAIN,
    );
    expect(logger.info).toHaveBeenCalledWith(
      'R4 cookies restored into Chrome from R4_SESSION_TOKEN',
    );
    expect(provider.plan).toBe('Code Lite');
  });

  it('omits cf_clearance when only the session token is configured', async () => {
    refreshCookiesViaBrowser.mockResolvedValue(CDP_FAILURE);
    configRef.sessionToken = ENV_TOKEN;

    await new R4().fetchUsage();

    expect(restoreCookiesViaBrowser).toHaveBeenCalledWith(
      `${CDP_OPTIONS.cookieName}=${ENV_TOKEN}`,
      DOMAIN,
    );
  });

  it('keeps going when the env cookie cannot be pushed into Chrome', async () => {
    refreshCookiesViaBrowser.mockResolvedValue(CDP_FAILURE);
    restoreCookiesViaBrowser.mockResolvedValue(false);
    configRef.sessionToken = ENV_TOKEN;

    const provider = await new R4().fetchUsage();

    expect(logger.info).not.toHaveBeenCalled();
    expect(navigateViaBrowser).toHaveBeenCalledWith(DASHBOARD_URL);
    expect(provider.plan).toBe('Code Lite');
  });

  it('reports a failed dashboard navigation with the CDP error text', async () => {
    navigateViaBrowser.mockResolvedValue({
      ok: false,
      error: 'Chrome not found at http://127.0.0.1:9222',
    });

    await expect(new R4().fetchUsage()).rejects.toThrow(
      'R4 dashboard navigation failed: Chrome not found at http://127.0.0.1:9222',
    );
  });

  it('treats a Cloudflare challenge body as an expired session', async () => {
    evaluateInPage.mockResolvedValue('<!DOCTYPE html><html><head><title>Just a moment…</title>');

    await expect(new R4().fetchUsage()).rejects.toThrow(SESSION_EXPIRED);
  });

  it('treats a payload without the grant fields as an expired session', async () => {
    evaluateInPage.mockResolvedValue(JSON.stringify({ json: { packageName: 'Code Lite' } }));

    await expect(new R4().fetchUsage()).rejects.toThrow(SESSION_EXPIRED);
  });

  it('treats a malformed dollar amount as an expired session', async () => {
    evaluateInPage.mockResolvedValue(
      JSON.stringify({ json: { ...GRANT_SAMPLE, totalUsd: 'n/a' } }),
    );

    await expect(new R4().fetchUsage()).rejects.toThrow(SESSION_EXPIRED);
  });

  it('treats a non-string evaluation result as an expired session', async () => {
    evaluateInPage.mockResolvedValue(undefined);

    await expect(new R4().fetchUsage()).rejects.toThrow(SESSION_EXPIRED);
  });
});
