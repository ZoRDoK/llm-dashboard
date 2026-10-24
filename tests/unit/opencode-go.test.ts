import { beforeEach, describe, expect, it, vi } from 'vitest';
import { goWindowsFromStatus } from '../../src/adapters/opencode-go.js';

// Live `/go/status` sample (2026-09-22): meters hold string microcents,
// `month` has no reset timestamps.
const STATUS_SAMPLE = {
  subscriberUserId: 'acc_1',
  renewalCurrency: 'usd',
  useBalance: false,
  cancelAtPeriodEnd: false,
  access: {
    startsAt: '2026-09-02T08:33:23.000Z',
    endsAt: '2026-10-02T08:33:23.000Z',
    cancelAtPeriodEnd: false,
    meters: {
      fiveHour: {
        startsAt: '2026-09-21T17:50:04.826Z',
        resetsAt: '2026-09-21T22:50:04.826Z',
        limitMicroCents: '1200000000',
        usedMicroCents: '27605866',
      },
      week: {
        startsAt: '2026-09-21T00:00:00.000Z',
        resetsAt: '2026-09-28T00:00:00.000Z',
        limitMicroCents: '3000000000',
        usedMicroCents: '70116641',
      },
      month: {
        limitMicroCents: '6000000000',
        usedMicroCents: '3698381418',
      },
    },
  },
};

const WINDOW_COUNT = 3;
const FIVE_HOUR_PERCENT = 2.3;
const WEEK_PERCENT = 2.3;
const MONTH_PERCENT = 61.6;

describe('goWindowsFromStatus', () => {
  it('builds the three meter windows with their labels and percents', () => {
    const windows = goWindowsFromStatus(STATUS_SAMPLE);

    expect(windows).toHaveLength(WINDOW_COUNT);
    expect(windows.map((window) => window.label)).toEqual(['5h', 'weekly', 'monthly']);
    expect(windows.map((window) => window.usedPercent)).toEqual([
      FIVE_HOUR_PERCENT,
      WEEK_PERCENT,
      MONTH_PERCENT,
    ]);
  });

  it('passes the meter resetAt through and leaves the month reset null', () => {
    const windows = goWindowsFromStatus(STATUS_SAMPLE);

    expect(windows.map((window) => window.resetAt)).toEqual([
      '2026-09-21T22:50:04.826Z',
      '2026-09-28T00:00:00.000Z',
      null,
    ]);
  });

  it('formats the value label as dollars used of the dollar limit', () => {
    const windows = goWindowsFromStatus(STATUS_SAMPLE);

    expect(windows.map((window) => window.valueLabel)).toEqual([
      '$0.28 of $12.00',
      '$0.70 of $30.00',
      '$36.98 of $60.00',
    ]);
  });

  it('throws on a payload without meters', () => {
    expect(() => goWindowsFromStatus({ access: {} })).toThrow();
  });

  it('throws when a microcent field is missing', () => {
    const broken = {
      access: {
        meters: {
          fiveHour: { limitMicroCents: '1', usedMicroCents: '1' },
          week: { limitMicroCents: '1', usedMicroCents: '1' },
          month: { usedMicroCents: '1' },
        },
      },
    };

    expect(() => goWindowsFromStatus(broken)).toThrow();
  });
});
// ── Usage API + session fallback ──────────────────────────

vi.mock('../../src/fetch-utils.js', () => ({ fetchRaw: vi.fn() }));

vi.mock('../../src/browser-cookies.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/browser-cookies.js')>()),
  refreshCookiesViaBrowser: vi.fn(),
}));

vi.mock('../../src/adapters/opencode-http.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/adapters/opencode-http.js')>()),
  fetchOpenCodeApi: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn() }),
}));

import { goWindowsFromUsageApi, OpenCodeGo } from '../../src/adapters/opencode-go.js';
import { fetchOpenCodeApi } from '../../src/adapters/opencode-http.js';
import { refreshCookiesViaBrowser } from '../../src/browser-cookies.js';
import { fetchRaw } from '../../src/fetch-utils.js';

const mockedFetchRaw = vi.mocked(fetchRaw);
const mockedProfile = vi.mocked(refreshCookiesViaBrowser);
const mockedApi = vi.mocked(fetchOpenCodeApi);

const USAGE_SAMPLE = {
  usage: {
    rolling: { status: 'ok', percent: 8.5, resetsAt: '2026-10-24T20:00:31.000Z' },
    weekly: { status: 'ok', percent: 3, resetsAt: '2026-10-26T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 87, resetsAt: '2026-11-02T08:33:23.000Z' },
  },
};

function usageResponse(payload: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 401, json: async () => payload } as unknown as Response;
}

describe('goWindowsFromUsageApi', () => {
  it('maps rolling/weekly/monthly to 5h/weekly/monthly with percent and reset', () => {
    const windows = goWindowsFromUsageApi(USAGE_SAMPLE);

    expect(windows.map((w) => w.label)).toEqual(['5h', 'weekly', 'monthly']);
    expect(windows.map((w) => w.usedPercent)).toEqual([8.5, 3, 87]);
    expect(windows.map((w) => w.resetAt)).toEqual([
      '2026-10-24T20:00:31.000Z',
      '2026-10-26T00:00:00.000Z',
      '2026-11-02T08:33:23.000Z',
    ]);
  });

  it('keeps a missing reset as null instead of inventing one', () => {
    const payload = {
      usage: {
        rolling: { status: 'ok', percent: 1 },
        weekly: { status: 'ok', percent: 2, resetsAt: null },
        monthly: { status: 'ok', percent: 3 },
      },
    };

    expect(goWindowsFromUsageApi(payload).map((w) => w.resetAt)).toEqual([null, null, null]);
  });

  it('throws on a payload without the usage meters', () => {
    expect(() => goWindowsFromUsageApi({})).toThrow();
  });
});

describe('OpenCodeGo usage source', () => {
  beforeEach(() => {
    mockedFetchRaw.mockReset();
    mockedProfile.mockReset();
    mockedApi.mockReset();
    mockedApi.mockResolvedValue(STATUS_SAMPLE);
  });

  it('uses the usage API with the account key and skips cookie sources', async () => {
    mockedFetchRaw.mockResolvedValue(usageResponse(USAGE_SAMPLE));

    const adapter = new OpenCodeGo({
      apiKey: 'test-key',
      sessionCookie: 'env-session',
      workspaceId: 'ws',
      cdpUrl: 'http://127.0.0.1:9341',
    });

    const provider = await adapter.fetchUsage();

    expect(mockedFetchRaw).toHaveBeenCalledWith('https://opencode.ai/zen/go/v1/usage', {
      headers: { Authorization: 'Bearer test-key', Accept: 'application/json' },
    });
    expect(mockedProfile).not.toHaveBeenCalled();
    expect(mockedApi).not.toHaveBeenCalled();
    expect(provider.models[0].windows.map((w) => w.usedPercent)).toEqual([8.5, 3, 87]);
  });

  it('falls back to the console session when the key is rejected', async () => {
    mockedFetchRaw.mockResolvedValue(usageResponse({}, false));
    mockedProfile.mockResolvedValue({
      ok: true,
      cookieString: '__Host-console_session=browser-session',
      mode: 'cdp',
    });

    const adapter = new OpenCodeGo({
      apiKey: 'stale-key',
      sessionCookie: 'env-session',
      workspaceId: 'ws',
      cdpUrl: 'http://127.0.0.1:9341',
    });

    await adapter.fetchUsage();

    expect(mockedApi).toHaveBeenCalledWith('browser-session', 'ws', '/go/status');
  });

  it('falls back to the console session when the usage request fails', async () => {
    mockedFetchRaw.mockRejectedValue(new Error('network down'));
    mockedProfile.mockResolvedValue({
      ok: true,
      cookieString: 'other=x; __Host-console_session=browser-session',
      mode: 'cdp',
    });

    const adapter = new OpenCodeGo({
      apiKey: 'flaky-key',
      sessionCookie: 'env-session',
      workspaceId: 'ws',
      cdpUrl: 'http://127.0.0.1:9341',
    });

    await adapter.fetchUsage();

    expect(mockedApi).toHaveBeenCalledWith('browser-session', 'ws', '/go/status');
  });

  it('ignores the account-1 key when a second account has no key of its own', async () => {
    mockedFetchRaw.mockResolvedValue(usageResponse(USAGE_SAMPLE));

    const adapter = new OpenCodeGo({
      id: 'opencode-go-2',
      sessionCookie: 'env-session',
      workspaceId: 'ws',
    });

    const provider = await adapter.fetchUsage();

    expect(mockedFetchRaw).not.toHaveBeenCalled();
    expect(mockedApi).toHaveBeenCalledWith('env-session', 'ws', '/go/status');
    expect(provider.id).toBe('opencode-go-2');
  });

  it('uses the env cookie when neither key nor profile session is available', async () => {
    mockedProfile.mockResolvedValue({ ok: false, cookieString: null, mode: 'cdp' });

    const adapter = new OpenCodeGo({
      id: 'opencode-go-test',
      sessionCookie: 'env-session',
      workspaceId: 'ws',
    });

    await adapter.fetchUsage();

    expect(mockedFetchRaw).not.toHaveBeenCalled();
    expect(mockedApi).toHaveBeenCalledWith('env-session', 'ws', '/go/status');
  });
});
