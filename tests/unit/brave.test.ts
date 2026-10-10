import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchText = vi.hoisted(() => vi.fn());

vi.mock('../../src/fetch-utils.js', () => ({ fetchText }));

vi.mock('../../src/config.js', () => ({
  config: { BRAVE_COOKIE: 'brave_session=cookie' },
}));

type BraveModule = typeof import('../../src/adapters/brave.js');

const USED_PERCENT = 3.5;
const TOKENS_IN = 10;
const TOKENS_OUT = 20;
const ROUNDED_PERCENT = 4;

/** NDJSON line the dashboard streams for a healthy session. */
const USAGE_CHUNK = JSON.stringify({
  type: 'chunk',
  data: [
    {
      currentMonthUsage: {
        tokensIn: TOKENS_IN,
        tokensOut: TOKENS_OUT,
        quotaUsedPrc: USED_PERCENT,
      },
      monthlyLimit: 1000,
    },
  ],
});

/** Single chunk the dashboard serves instead of data when the cookie expired. */
const LOGIN_REDIRECT_CHUNK = JSON.stringify({
  type: 'redirect',
  location: '/login?redirect=%2Fapp%2Fdashboard',
});

/** Redirect to a non-login target must not be reported as an expired session. */
const OTHER_REDIRECT_CHUNK = JSON.stringify({
  type: 'redirect',
  location: '/app/billing',
});

describe('Brave.fetchUsage chunk parsing', () => {
  let Brave: BraveModule['Brave'];

  beforeEach(async () => {
    vi.resetModules();
    ({ Brave } = await import('../../src/adapters/brave.js'));
    fetchText.mockReset();
  });

  it('throws an actionable error for a login redirect chunk', async () => {
    fetchText.mockResolvedValue(LOGIN_REDIRECT_CHUNK);

    await expect(new Brave().fetchUsage()).rejects.toThrow(
      'Brave session expired — update BRAVE_COOKIE',
    );
  });

  it('parses a normal usage chunk into a monthly window', async () => {
    fetchText.mockResolvedValue(USAGE_CHUNK);

    const provider = await new Brave().fetchUsage();
    const window = provider.models[0]?.windows[0];

    expect(provider.error).toBeUndefined();
    expect(window?.label).toBe('monthly');
    expect(window?.usedPercent).toBe(ROUNDED_PERCENT);
    expect(window?.valueLabel).toBe(`${TOKENS_IN + TOKENS_OUT} tokens`);
  });

  it('keeps the generic error for a non-login redirect chunk', async () => {
    fetchText.mockResolvedValue(OTHER_REDIRECT_CHUNK);

    await expect(new Brave().fetchUsage()).rejects.toThrow(
      'Brave usage data not found in dashboard response',
    );
  });

  it('keeps the generic error for an unknown chunk shape', async () => {
    fetchText.mockResolvedValue(JSON.stringify({ type: 'chunk', data: [{}] }));

    await expect(new Brave().fetchUsage()).rejects.toThrow(
      'Brave usage data not found in dashboard response',
    );
  });
});
