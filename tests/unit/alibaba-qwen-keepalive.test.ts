import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MS_PER_HOUR } from '../../src/constants.js';

const fetchText = vi.hoisted(() => vi.fn());
const fetchJsonWith = vi.hoisted(() => vi.fn());
const postFormJson = vi.hoisted(() => vi.fn());
const readDataFile = vi.hoisted(() => vi.fn());
const writeDataFile = vi.hoisted(() => vi.fn());
const refreshCookiesViaBrowser = vi.hoisted(() => vi.fn());
const navigateViaBrowser = vi.hoisted(() => vi.fn());
const configRef = vi.hoisted(() => ({ keepaliveHours: 6 }));
const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({ createLogger: () => logger }));

vi.mock('../../src/fetch-utils.js', () => ({
  fetchText,
  fetchJsonWith,
  postFormJson,
}));

vi.mock('../../src/data-file.js', () => ({ readDataFile, writeDataFile }));

vi.mock('../../src/browser-cookies.js', () => ({ refreshCookiesViaBrowser, navigateViaBrowser }));

vi.mock('../../src/config.js', () => ({
  config: {
    ALIBABA_QWEN_COOKIE: undefined,
    get ALIBABA_QWEN_KEEPALIVE_HOURS(): number {
      return configRef.keepaliveHours;
    },
  },
}));

type AlibabaQwenModule = typeof import('../../src/adapters/alibaba-qwen.js');

const FIXTURE_COOKIE = 'login_aliyunid_ticket=ticket; other=o';
const FRESH_COOKIE = 'login_aliyunid_ticket=fresh-ticket; other=o';
const KEEPALIVE_HOURS = 6;
const HALF_USED = 0.5;
const KEEPALIVE_INTERVAL_MS = KEEPALIVE_HOURS * MS_PER_HOUR;

const CDP_OPTIONS = {
  domain: 'alibabacloud.com',
  cookieName: 'login_aliyunid_ticket',
  exactName: true,
} as const;

const PAGE_URL = 'https://modelstudio.console.alibabacloud.com/ap-southeast-1/tokenPlan';
// The console's own Log In target: the shell no longer starts the silent SSO
// chain, so the keepalive navigation must use this endpoint.
const SSO_LOGIN_URL = `https://account.alibabacloud.com/login/login.htm?oauth_callback=${encodeURIComponent(PAGE_URL)}&clearRedirectCookie=1`;

const NAVIGATION_OK = { ok: true } as const;
const NAVIGATION_FAILURE = { ok: false, error: 'navigation timed out after 15000ms' } as const;
const CDP_SUCCESS = { ok: true, cookieString: FRESH_COOKIE, mode: 'cdp' } as const;
const CDP_FAILURE = { ok: false, cookieString: null, mode: 'none' } as const;

/** Envelope the gateway returns for a healthy token-plan session. */
function successEnvelope(usedFraction: number): unknown {
  return {
    successResponse: true,
    data: {
      DataV2: {
        data: {
          code: '0',
          msg: 'success',
          success: true,
          data: { per1WeekResetTime: 1_787_190_540_000, per1WeekPercentage: usedFraction },
        },
      },
    },
  };
}

/** Flat envelope a logged-out session gets: no DataV2, only an errorCode. */
const LOGIN_ERROR_ENVELOPE = {
  code: '200',
  successResponse: true,
  data: {
    success: false,
    errorCode: 'BailianGateway.Login.NotLogined',
    errorMsg: 'BailianGateway.Login.NotLogined',
  },
};

describe('AlibabaQwen silent-SSO keepalive', () => {
  let AlibabaQwen: AlibabaQwenModule['AlibabaQwen'];

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    ({ AlibabaQwen } = await import('../../src/adapters/alibaba-qwen.js'));

    configRef.keepaliveHours = KEEPALIVE_HOURS;
    logger.debug.mockReset();
    logger.info.mockReset();
    logger.warn.mockReset();
    logger.error.mockReset();

    fetchText.mockReset().mockResolvedValue('<html></html>');
    fetchJsonWith.mockReset().mockResolvedValue({ code: '0' });
    postFormJson.mockReset().mockResolvedValue(successEnvelope(HALF_USED));
    readDataFile.mockReset().mockReturnValue(FIXTURE_COOKIE);
    writeDataFile.mockReset();
    navigateViaBrowser.mockReset().mockResolvedValue(NAVIGATION_OK);
    refreshCookiesViaBrowser.mockReset().mockResolvedValue(CDP_SUCCESS);
  });

  afterEach(() => {
    // Drop the pending keepalive timer so no test leaks a live handle.
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('schedules the keepalive timer after a successful fetchUsage', async () => {
    const provider = await new AlibabaQwen().fetchUsage();

    expect(provider.error).toBeUndefined();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);

    expect(navigateViaBrowser).toHaveBeenCalledTimes(1);
    expect(navigateViaBrowser).toHaveBeenCalledWith(SSO_LOGIN_URL);
    expect(refreshCookiesViaBrowser).toHaveBeenCalledWith(CDP_OPTIONS);

    // The completed keepalive chained the next run.
    expect(vi.getTimerCount()).toBe(1);
  });

  it('schedules no keepalive when the configured interval is 0', async () => {
    configRef.keepaliveHours = 0;

    await new AlibabaQwen().fetchUsage();

    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);

    expect(navigateViaBrowser).not.toHaveBeenCalled();
  });

  it('refreshes and persists the cookie jar after a successful silent-SSO navigation', async () => {
    await new AlibabaQwen().fetchUsage();
    writeDataFile.mockClear();

    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);

    expect(writeDataFile).toHaveBeenCalledWith(
      'data/alibaba-qwen-cookies.txt',
      FRESH_COOKIE,
      'Alibaba Qwen cookies',
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Alibaba Qwen session kept alive via silent SSO refresh',
    );

    // The next fetch rides on the refreshed cookie jar, not the stale one.
    postFormJson.mockClear();
    await new AlibabaQwen().fetchUsage();

    const [, headers] = postFormJson.mock.lastCall as unknown as [
      string,
      Record<string, string>,
      URLSearchParams,
    ];

    expect(headers.cookie).toBe(FRESH_COOKIE);
  });

  it('skips the keepalive entirely when no cookies are stored', async () => {
    readDataFile.mockReturnValue(null);
    refreshCookiesViaBrowser.mockResolvedValue(CDP_FAILURE);

    const provider = await new AlibabaQwen().fetchUsage();

    expect(provider.plan).toBe('Not configured');

    // The bootstrap CDP attempt ran once; the keepalive run must not add
    // any navigation or CDP traffic on top of it.
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);

    expect(navigateViaBrowser).not.toHaveBeenCalled();
    expect(refreshCookiesViaBrowser).toHaveBeenCalledTimes(1);
  });

  it('leaves the stored cookies untouched when the navigation fails', async () => {
    navigateViaBrowser.mockResolvedValue(NAVIGATION_FAILURE);

    await new AlibabaQwen().fetchUsage();
    writeDataFile.mockClear();

    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);

    expect(logger.warn).toHaveBeenCalledWith(
      { reason: 'navigation timed out after 15000ms' },
      'Alibaba Qwen keepalive: navigation failed',
    );
    expect(navigateViaBrowser).toHaveBeenCalledWith(SSO_LOGIN_URL);
    expect(refreshCookiesViaBrowser).not.toHaveBeenCalled();
    expect(writeDataFile).not.toHaveBeenCalled();

    // The next fetch still uses the old cookie jar.
    postFormJson.mockClear();
    await new AlibabaQwen().fetchUsage();

    const [, headers] = postFormJson.mock.lastCall as unknown as [
      string,
      Record<string, string>,
      URLSearchParams,
    ];

    expect(headers.cookie).toBe(FIXTURE_COOKIE);
  });

  it('keeps the old session without a cooldown when refreshed cookies fail the login probe', async () => {
    fetchJsonWith.mockResolvedValue({ code: 'ConsoleNeedLogin' });

    await new AlibabaQwen().fetchUsage();
    writeDataFile.mockClear();

    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('silent SSO refresh failed'));
    expect(writeDataFile).not.toHaveBeenCalled();

    // A later failing fetch still retries CDP recovery: the keepalive never
    // starts the login cooldown. Recovery's own extraction and its one SSO
    // re-extraction both get rejected.
    postFormJson.mockResolvedValue(LOGIN_ERROR_ENVELOPE);

    await expect(new AlibabaQwen().fetchUsage()).rejects.toThrow('Console session expired');

    // 1 (keepalive refresh) + 1 (fetch-failure recovery) + 1 (SSO re-extraction).
    // biome-ignore lint/style/noMagicNumbers: keepalive + recovery + SSO re-extraction
    expect(refreshCookiesViaBrowser).toHaveBeenCalledTimes(3);
    expect(navigateViaBrowser).toHaveBeenCalledWith(SSO_LOGIN_URL);
  });

  it('keeps the previous session when the keepalive login probe itself fails', async () => {
    // The user-info probe rejects (e.g. timeout): that says nothing about the
    // login, so it must be reported distinctly and must not swap cookies.
    fetchJsonWith.mockRejectedValue(new Error('The operation was aborted due to timeout'));

    await new AlibabaQwen().fetchUsage();
    writeDataFile.mockClear();

    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('login probe unavailable'));
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('silent SSO refresh failed'),
    );
    expect(writeDataFile).not.toHaveBeenCalled();

    // The next fetch still rides the previous cookie jar.
    postFormJson.mockClear();
    await new AlibabaQwen().fetchUsage();

    const [, headers] = postFormJson.mock.lastCall as unknown as [
      string,
      Record<string, string>,
      URLSearchParams,
    ];

    expect(headers.cookie).toBe(FIXTURE_COOKIE);

    // A later failing fetch still attempts CDP recovery: no cooldown started.
    postFormJson.mockResolvedValue(LOGIN_ERROR_ENVELOPE);

    await expect(new AlibabaQwen().fetchUsage()).rejects.toThrow('Console session expired');

    // 1 (keepalive refresh) + 1 (fetch-failure recovery) CDP attempts.
    expect(refreshCookiesViaBrowser).toHaveBeenCalledTimes(2);
  });
});
