import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MS_PER_MINUTE } from '../../src/constants.js';

const fetchText = vi.hoisted(() => vi.fn());
const fetchJsonWith = vi.hoisted(() => vi.fn());
const postFormJson = vi.hoisted(() => vi.fn());
const readDataFile = vi.hoisted(() => vi.fn());
const writeDataFile = vi.hoisted(() => vi.fn());
const refreshCookiesViaBrowser = vi.hoisted(() => vi.fn());
const navigateViaBrowser = vi.hoisted(() => vi.fn());
const restoreCookiesViaBrowser = vi.hoisted(() => vi.fn());
const parseCookiePairs = vi.hoisted(() => vi.fn());

vi.mock('../../src/fetch-utils.js', () => ({
  fetchText,
  fetchJsonWith,
  postFormJson,
}));

vi.mock('../../src/data-file.js', () => ({ readDataFile, writeDataFile }));

// Hoisted module-level mock so AlibabaQwen binds to it at import time. The old
// vi.doMock ran after the static import and could leave the real CDP client
// bound, letting a test reach live Chrome. It is reset to a deterministic
// failure in beforeEach so no test can touch the network.
vi.mock('../../src/browser-cookies.js', () => ({
  refreshCookiesViaBrowser,
  navigateViaBrowser,
  restoreCookiesViaBrowser,
  parseCookiePairs,
}));

type AlibabaQwenModule = typeof import('../../src/adapters/alibaba-qwen.js');

const FIXTURE_COOKIE = 'login_aliyunid_ticket=ticket; other=o';
const SEC_TOKEN_COOKIE = 'login_aliyunid_ticket=ticket; sec_token=tok-cookie; other=o';

const PAGE_URL = 'https://modelstudio.console.alibabacloud.com/ap-southeast-1/tokenPlan';
// The console's own Log In target: navigations must go through it because the
// console shell no longer starts the silent SSO chain on its own.
const SSO_LOGIN_URL = `https://account.alibabacloud.com/login/login.htm?oauth_callback=${encodeURIComponent(PAGE_URL)}&clearRedirectCookie=1`;

const HALF_USED = 0.5;
const QUARTER_USED = 0.25;
const HALF_PERCENT = 50;

// Fake-clock steps for the cooldown regression test (cooldown is 10 minutes).
const NINE_MINUTES_MS = 9 * MS_PER_MINUTE;
const TWO_MINUTES_MS = 2 * MS_PER_MINUTE;

// The adapter's own fetch budget; the shared default is only 10_000.
const QWEN_TIMEOUT_MS = 30_000;

/** Deterministic CDP failure: no cookie, no live Chrome. */
const CDP_FAILURE = { ok: false, cookieString: null, mode: 'none' } as const;

/** CDP failure when Chrome holds no console login ticket at all. */
const NO_TICKET_FAILURE = {
  ok: false,
  cookieString: null,
  mode: 'cdp',
  error: 'No login_aliyunid_ticket cookie found — are you logged into the target site?',
} as const;

/** Persisted jar that still carries the long-lived havana TGC SSO ticket. */
const HAVANA_JAR_COOKIE = 'login_aliyunid_ticket=stale; havana_tgc=tgc-ticket';

/** Stale login ticket that CDP keeps returning and the probe keeps rejecting. */
const STALE_CDP_COOKIE = 'login_aliyunid_ticket=stale; other=o';

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

/** CDP success shape with cookies that still have to pass the login probe. */
const CDP_COOKIE_STRING = 'login_aliyunid_ticket=fresh; other=o';

const cdpSuccess = () => ({ ok: true, cookieString: CDP_COOKIE_STRING, mode: 'cdp' });

/** Post-rollover envelope: percentage zeroed and per1WeekResetTime omitted. */
const POST_RESET_ENVELOPE = {
  successResponse: true,
  data: {
    DataV2: {
      data: {
        code: '0',
        msg: 'success',
        success: true,
        data: { per1WeekPercentage: 0 },
      },
    },
  },
};

describe('AlibabaQwen.fetchUsage', () => {
  let AlibabaQwen: AlibabaQwenModule['AlibabaQwen'];

  beforeEach(async () => {
    // Reset the module-level cookie cache so each test controls its own cookie
    // via readDataFile instead of inheriting a cached value from a prior test.
    vi.resetModules();
    ({ AlibabaQwen } = await import('../../src/adapters/alibaba-qwen.js'));

    fetchText.mockReset();
    fetchJsonWith.mockReset();
    postFormJson.mockReset();
    readDataFile.mockReset().mockReturnValue(FIXTURE_COOKIE);
    writeDataFile.mockReset();
    refreshCookiesViaBrowser.mockReset().mockResolvedValue(CDP_FAILURE);
    navigateViaBrowser.mockReset().mockResolvedValue({ ok: true });
    restoreCookiesViaBrowser.mockReset().mockResolvedValue(false);
    parseCookiePairs.mockReset().mockReturnValue([]);
  });

  it('succeeds against the gateway with no sec_token when no source yields one', async () => {
    // Current ModelStudio HTML: authenticated/anonymous shell without any token spelling.
    fetchText.mockResolvedValue('<html><script>window.csrf=null;</script></html>');
    // user-info says the login probe found nothing useful.
    fetchJsonWith.mockResolvedValue({ code: 'ConsoleNeedLogin', successResponse: false });
    postFormJson.mockResolvedValue(successEnvelope(HALF_USED));

    const provider = await new AlibabaQwen().fetchUsage();

    expect(provider.error).toBeUndefined();
    expect(provider.plan).toBe('Token Plan');
    expect(provider.models[0]?.windows[0]?.usedPercent).toBe(HALF_PERCENT);

    // fetchConsoleHtml targets the Personal Token Plan dashboard with a
    // same-origin document navigation (Referer + Sec-Fetch-* headers).
    const [consoleUrl, consoleHeaders] = fetchText.mock.calls[0] as unknown as [
      string,
      Record<string, string>,
    ];

    expect(consoleUrl).toBe(
      'https://modelstudio.console.alibabacloud.com/ap-southeast-1/tokenPlan',
    );
    expect(consoleHeaders.referer).toBe(
      'https://modelstudio.console.alibabacloud.com/ap-southeast-1',
    );
    expect(consoleHeaders['sec-fetch-site']).toBe('same-origin');
    expect(consoleHeaders['sec-fetch-mode']).toBe('navigate');
    expect(consoleHeaders['sec-fetch-dest']).toBe('document');
    expect(consoleHeaders.accept).toBeDefined();
    expect(consoleHeaders['accept-language']).toBeDefined();
    expect(consoleHeaders['user-agent']).toBeDefined();
    expect(consoleHeaders.cookie).toBe(FIXTURE_COOKIE);

    const [url, headers, body] = postFormJson.mock.calls[0] as unknown as [
      string,
      Record<string, string>,
      URLSearchParams,
    ];

    // sec_token must be omitted entirely, not sent empty.
    expect(body.has('sec_token')).toBe(false);
    expect(body.get('region')).toBe('ap-southeast-1');

    // Browser-like navigation headers on the gateway POST.
    expect(headers.origin).toBe('https://modelstudio.console.alibabacloud.com');
    expect(headers.referer).toBe(
      'https://modelstudio.console.alibabacloud.com/ap-southeast-1/tokenPlan',
    );
    expect(url).toContain('bailian-singapore-cs.alibabacloud.com');
  });

  it('still sends sec_token when the console HTML embeds it', async () => {
    fetchText.mockResolvedValue('<script>var SEC_TOKEN = "tok-html";</script>');
    postFormJson.mockResolvedValue(successEnvelope(QUARTER_USED));

    const provider = await new AlibabaQwen().fetchUsage();

    expect(provider.error).toBeUndefined();

    const [, , body] = postFormJson.mock.calls[0] as unknown as [
      string,
      Record<string, string>,
      URLSearchParams,
    ];

    expect(body.get('sec_token')).toBe('tok-html');
    expect(fetchJsonWith).not.toHaveBeenCalled();
  });

  it('still sends sec_token from the cookie when the console HTML fetch fails', async () => {
    // Regression: an HTML fetch failure must not skip the sec_token cookie
    // fallback — the old single-try catch returned null for every source.
    readDataFile.mockReturnValue(SEC_TOKEN_COOKIE);
    fetchText.mockRejectedValue(new Error('HTTP 503'));
    postFormJson.mockResolvedValue(successEnvelope(HALF_USED));

    const provider = await new AlibabaQwen().fetchUsage();

    expect(provider.error).toBeUndefined();

    const [, , body] = postFormJson.mock.calls[0] as unknown as [
      string,
      Record<string, string>,
      URLSearchParams,
    ];

    expect(body.get('sec_token')).toBe('tok-cookie');
    // The cookie yielded a token, so the user-info fallback was not needed.
    expect(fetchJsonWith).not.toHaveBeenCalled();
  });

  it('succeeds with zero usage and resetAt null when the gateway omits per1WeekResetTime', async () => {
    // Regression: right after the weekly reset the gateway answers with
    // per1WeekPercentage: 0 and no per1WeekResetTime; the required-number
    // schema rejected that payload and left stale pre-reset data visible.
    fetchText.mockResolvedValue('<html></html>');
    postFormJson.mockResolvedValue(POST_RESET_ENVELOPE);

    const provider = await new AlibabaQwen().fetchUsage();

    expect(provider.error).toBeUndefined();
    expect(provider.models[0]?.windows[0]?.usedPercent).toBe(0);
    expect(provider.models[0]?.windows[0]?.resetAt).toBeNull();
  });

  it('rewrites a gateway login failure into an actionable session-expired error', async () => {
    fetchText.mockResolvedValue('<html></html>');
    fetchJsonWith.mockResolvedValue({ code: 'ConsoleNeedLogin', successResponse: false });
    postFormJson.mockResolvedValue(LOGIN_ERROR_ENVELOPE);

    await expect(new AlibabaQwen().fetchUsage()).rejects.toThrow(
      'Console session expired — open http://127.0.0.1:13000 and log in at modelstudio.console.alibabacloud.com',
    );

    // The expired session triggered exactly one best-effort CDP refresh, which
    // stayed deterministic (no live Chrome) and could not recover the session.
    expect(refreshCookiesViaBrowser).toHaveBeenCalledTimes(1);
  });

  it('rejects CDP cookies the login probe says are logged out, without retrying the gateway', async () => {
    refreshCookiesViaBrowser.mockResolvedValue(cdpSuccess());
    fetchText.mockResolvedValue('<html></html>');
    // Every user-info call (sec-token fallback and login probe) says logged out.
    fetchJsonWith.mockResolvedValue({ code: 'ConsoleNeedLogin' });
    postFormJson.mockResolvedValueOnce(LOGIN_ERROR_ENVELOPE);

    await expect(new AlibabaQwen().fetchUsage()).rejects.toThrow('Console session expired');

    // The gateway was called once with the stored cookies and never retried
    // with the dead CDP cookies.
    expect(postFormJson).toHaveBeenCalledTimes(1);
    expect(writeDataFile).not.toHaveBeenCalled();
  });

  it('retries the gateway with CDP cookies that pass the login probe', async () => {
    refreshCookiesViaBrowser.mockResolvedValue(cdpSuccess());
    fetchText.mockResolvedValue('<script>var SEC_TOKEN = "tok-html";</script>');
    // The login probe accepts these cookies (code '0' = success).
    fetchJsonWith.mockResolvedValue({ code: '0', data: {} });
    postFormJson
      .mockResolvedValueOnce(LOGIN_ERROR_ENVELOPE)
      .mockResolvedValueOnce(successEnvelope(HALF_USED));

    const provider = await new AlibabaQwen().fetchUsage();

    expect(provider.error).toBeUndefined();
    expect(provider.models[0]?.windows[0]?.usedPercent).toBe(HALF_PERCENT);
    expect(postFormJson).toHaveBeenCalledTimes(2);
    expect(writeDataFile).toHaveBeenCalledWith(
      'data/alibaba-qwen-cookies.txt',
      CDP_COOKIE_STRING,
      'Alibaba Qwen cookies',
    );

    // The retry used the refreshed cookie string, not the stale stored one.
    const [, retryHeaders] = postFormJson.mock.calls[1] as unknown as [
      string,
      Record<string, string>,
      URLSearchParams,
    ];

    expect(retryHeaders.cookie).toBe(CDP_COOKIE_STRING);
  });

  it('re-mints the session through the SSO re-login endpoint when CDP cookies fail the probe', async () => {
    // Chrome holds an expired login ticket: the direct extraction probes as
    // logged out, one SSO re-login navigation re-mints the ticket, and the
    // gateway retry then succeeds with the fresh cookies.
    refreshCookiesViaBrowser
      .mockResolvedValueOnce({ ok: true, cookieString: STALE_CDP_COOKIE, mode: 'cdp' })
      .mockResolvedValueOnce(cdpSuccess());
    fetchText.mockResolvedValue('<html></html>');
    // The stale cookie string probes logged out; the re-minted jar probes alive.
    fetchJsonWith.mockImplementation((...args: unknown[]) => {
      const headers = args[1] as { cookie: string };
      const code = headers.cookie === STALE_CDP_COOKIE ? 'ConsoleNeedLogin' : '0';

      return Promise.resolve({ code });
    });
    postFormJson
      .mockResolvedValueOnce(LOGIN_ERROR_ENVELOPE)
      .mockResolvedValueOnce(successEnvelope(HALF_USED));

    const provider = await new AlibabaQwen().fetchUsage();

    expect(provider.error).toBeUndefined();
    expect(provider.models[0]?.windows[0]?.usedPercent).toBe(HALF_PERCENT);

    // Exactly one SSO re-login navigation, then the gateway retried the
    // session with the re-minted cookie jar.
    expect(navigateViaBrowser).toHaveBeenCalledTimes(1);
    expect(navigateViaBrowser).toHaveBeenCalledWith(SSO_LOGIN_URL);
    expect(refreshCookiesViaBrowser).toHaveBeenCalledTimes(2);
    expect(writeDataFile).toHaveBeenCalledWith(
      'data/alibaba-qwen-cookies.txt',
      CDP_COOKIE_STRING,
      'Alibaba Qwen cookies',
    );

    const [, retryHeaders] = postFormJson.mock.calls[1] as unknown as [
      string,
      Record<string, string>,
      URLSearchParams,
    ];

    expect(retryHeaders.cookie).toBe(CDP_COOKIE_STRING);
  });

  it('keeps the logged-out outcome when the SSO re-login navigation fails', async () => {
    // Chrome holds dead cookies and its SSO re-login tab cannot load, so the
    // retry yields nothing to probe and 'logged-out' still starts the cooldown.
    refreshCookiesViaBrowser.mockResolvedValue(cdpSuccess());
    navigateViaBrowser.mockResolvedValue({
      ok: false,
      error: 'navigation timed out after 15000ms',
    });
    fetchText.mockResolvedValue('<html></html>');
    fetchJsonWith.mockResolvedValue({ code: 'ConsoleNeedLogin' });
    postFormJson.mockResolvedValue(LOGIN_ERROR_ENVELOPE);

    await expect(new AlibabaQwen().fetchUsage()).rejects.toThrow('Console session expired');

    expect(navigateViaBrowser).toHaveBeenCalledTimes(1);
    expect(navigateViaBrowser).toHaveBeenCalledWith(SSO_LOGIN_URL);

    // The failed navigation produced no second extraction to probe.
    expect(refreshCookiesViaBrowser).toHaveBeenCalledTimes(1);
    expect(writeDataFile).not.toHaveBeenCalled();

    await expect(new AlibabaQwen().fetchUsage()).rejects.toThrow('Console session expired');

    // The propagated 'logged-out' still started the cooldown: the next tick
    // skips CDP while the cheap gateway probe keeps ticking.
    expect(refreshCookiesViaBrowser).toHaveBeenCalledTimes(1);
    expect(postFormJson).toHaveBeenCalledTimes(2);
  });

  it('restores the persisted jar and re-mints through the SSO re-login endpoint', async () => {
    // Chrome lost its profile, so it has no login ticket, but the persisted
    // jar still carries the long-lived havana TGC: the adapter pushes the jar
    // back in and the SSO re-login navigation re-mints the ticket before the
    // fresh cookies are probed.
    readDataFile.mockReturnValue(HAVANA_JAR_COOKIE);
    restoreCookiesViaBrowser.mockResolvedValue(true);
    parseCookiePairs.mockReturnValue([{ name: 'havana_tgc', value: 'tgc-ticket' }]);
    refreshCookiesViaBrowser
      .mockResolvedValueOnce(NO_TICKET_FAILURE)
      .mockResolvedValueOnce(cdpSuccess());
    fetchText.mockResolvedValue('<html></html>');
    fetchJsonWith.mockResolvedValue({ code: '0', data: {} });
    postFormJson
      .mockResolvedValueOnce(LOGIN_ERROR_ENVELOPE)
      .mockResolvedValueOnce(successEnvelope(HALF_USED));

    const provider = await new AlibabaQwen().fetchUsage();

    expect(provider.error).toBeUndefined();
    expect(restoreCookiesViaBrowser).toHaveBeenCalledWith(HAVANA_JAR_COOKIE, 'alibabacloud.com');
    expect(navigateViaBrowser).toHaveBeenCalledTimes(1);
    expect(navigateViaBrowser).toHaveBeenCalledWith(SSO_LOGIN_URL);
    expect(postFormJson).toHaveBeenCalledTimes(2);
    expect(writeDataFile).toHaveBeenCalledWith(
      'data/alibaba-qwen-cookies.txt',
      CDP_COOKIE_STRING,
      'Alibaba Qwen cookies',
    );
  });

  it('starts the CDP cooldown when extracted cookies are rejected by the login probe', async () => {
    refreshCookiesViaBrowser.mockResolvedValue(cdpSuccess());
    fetchText.mockResolvedValue('<html></html>');
    // Every user-info call (sec-token fallback and login probe) says logged out.
    fetchJsonWith.mockResolvedValue({ code: 'ConsoleNeedLogin' });
    postFormJson.mockResolvedValue(LOGIN_ERROR_ENVELOPE);

    await expect(new AlibabaQwen().fetchUsage()).rejects.toThrow('Console session expired');
    await expect(new AlibabaQwen().fetchUsage()).rejects.toThrow('Console session expired');

    // Only the first failure probed CDP: the extraction and its one SSO
    // re-extraction both got rejected, and those rejected cookies started the
    // cooldown, so the second tick inside the window skips CDP while the
    // cheap gateway probe keeps ticking.
    expect(navigateViaBrowser).toHaveBeenCalledWith(SSO_LOGIN_URL);
    expect(refreshCookiesViaBrowser).toHaveBeenCalledTimes(2);
    expect(postFormJson).toHaveBeenCalledTimes(2);
  });

  it('retries CDP once the cooldown window has passed', async () => {
    // Regression: the cooldown used to be re-extended on every login-required
    // gateway failure, so CDP was never re-attempted after the first
    // rejection — even after the user logged back into Chrome.
    vi.useFakeTimers();

    try {
      refreshCookiesViaBrowser.mockResolvedValue(cdpSuccess());
      fetchText.mockResolvedValue('<html></html>');
      fetchJsonWith.mockResolvedValue({ code: 'ConsoleNeedLogin' });
      postFormJson.mockResolvedValue(LOGIN_ERROR_ENVELOPE);

      await expect(new AlibabaQwen().fetchUsage()).rejects.toThrow('Console session expired');

      // Still inside the 10-minute window: the direct extraction and its SSO
      // re-extraction were both rejected, and started the cooldown.
      vi.setSystemTime(Date.now() + NINE_MINUTES_MS);

      await expect(new AlibabaQwen().fetchUsage()).rejects.toThrow('Console session expired');
      expect(refreshCookiesViaBrowser).toHaveBeenCalledTimes(2);

      // Past the window the cooldown has expired, so the next failing tick
      // probes CDP again (with another SSO re-extraction on top).
      vi.setSystemTime(Date.now() + TWO_MINUTES_MS);

      await expect(new AlibabaQwen().fetchUsage()).rejects.toThrow('Console session expired');
      // biome-ignore lint/style/noMagicNumbers: two ticks of direct extraction + SSO re-extraction
      expect(refreshCookiesViaBrowser).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries CDP on the next tick when Chrome is unavailable — no cooldown is started', async () => {
    // Chrome-not-found failure, as the real CDP client reports it.
    refreshCookiesViaBrowser.mockResolvedValue({
      ok: false,
      cookieString: null,
      mode: 'cdp',
      error: 'Chrome not found at http://127.0.0.1:9222',
    });
    fetchText.mockResolvedValue('<html></html>');
    fetchJsonWith.mockResolvedValue({ code: 'ConsoleNeedLogin' });
    postFormJson.mockResolvedValue(LOGIN_ERROR_ENVELOPE);

    await expect(new AlibabaQwen().fetchUsage()).rejects.toThrow('Console session expired');
    await expect(new AlibabaQwen().fetchUsage()).rejects.toThrow('Console session expired');

    // CDP failed rather than being rejected: no cooldown, so every tick
    // retries CDP as soon as Chrome is back.
    expect(refreshCookiesViaBrowser).toHaveBeenCalledTimes(2);
    expect(postFormJson).toHaveBeenCalledTimes(2);
  });

  it('does not start the cooldown or swap cookies when the recovery login probe fails', async () => {
    // The gateway says logged out, but the login probe itself cannot run
    // (e.g. the user-info request hits the timeout). A failed probe is not
    // evidence of a dead login, so the fresh CDP cookies must be discarded
    // without starting the cooldown.
    refreshCookiesViaBrowser.mockResolvedValue(cdpSuccess());
    fetchText.mockResolvedValue('<html></html>');
    fetchJsonWith.mockRejectedValue(new Error('The operation was aborted due to timeout'));
    postFormJson.mockResolvedValue(LOGIN_ERROR_ENVELOPE);

    await expect(new AlibabaQwen().fetchUsage()).rejects.toThrow('Console session expired');

    // No cookies were accepted, so nothing was persisted and the gateway ran
    // exactly once.
    expect(writeDataFile).not.toHaveBeenCalled();
    expect(postFormJson).toHaveBeenCalledTimes(1);

    // No cooldown was started: the very next tick probes CDP again.
    await expect(new AlibabaQwen().fetchUsage()).rejects.toThrow('Console session expired');

    expect(refreshCookiesViaBrowser).toHaveBeenCalledTimes(2);
  });

  it('forwards the 30s Qwen timeout budget to every ModelStudio fetch', async () => {
    // Regression: the shared 10s budget aborted healthy-but-slow ModelStudio
    // endpoints (measured 5–10.3s) into spurious timeout errors.
    fetchText.mockResolvedValue('<html></html>');
    // No HTML or cookie token, so the user-info fallback runs.
    fetchJsonWith.mockResolvedValue({ code: '0' });
    postFormJson.mockResolvedValue(successEnvelope(HALF_USED));

    const provider = await new AlibabaQwen().fetchUsage();

    expect(provider.error).toBeUndefined();
    expect(fetchJsonWith).toHaveBeenCalled();
    expect(fetchText).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.anything(),
      QWEN_TIMEOUT_MS,
    );
    expect(fetchJsonWith).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.anything(),
      QWEN_TIMEOUT_MS,
    );
    expect(postFormJson).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.anything(),
      expect.anything(),
      QWEN_TIMEOUT_MS,
    );
  });

  it('rides out one transient network blip on the console HTML fetch', async () => {
    // The first HTML fetch dies at the host network level (undici TypeError);
    // the single network retry recovers and the refresh still succeeds.
    fetchText
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue('<script>var SEC_TOKEN = "tok-html";</script>');
    postFormJson.mockResolvedValue(successEnvelope(HALF_USED));

    const provider = await new AlibabaQwen().fetchUsage();

    expect(provider.error).toBeUndefined();
    expect(provider.models[0]?.windows[0]?.usedPercent).toBe(HALF_PERCENT);
    expect(fetchText).toHaveBeenCalledTimes(2);
    expect(postFormJson).toHaveBeenCalledTimes(1);
  });

  it('reports the cause code when both gateway attempts hit the dead network', async () => {
    fetchText.mockResolvedValue('<script>var SEC_TOKEN = "tok-html";</script>');
    postFormJson
      .mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }))
      .mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }));

    await expect(new AlibabaQwen().fetchUsage()).rejects.toThrow('fetch failed (ECONNRESET)');

    // Exactly one network retry per call, then the deterministic CDP failure
    // lets the diagnostic error surface instead of a bare "fetch failed".
    expect(postFormJson).toHaveBeenCalledTimes(2);
  });
});
