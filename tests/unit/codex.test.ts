import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchJsonWith = vi.hoisted(() => vi.fn());

vi.mock('../../src/fetch-utils.js', () => ({ fetchJsonWith }));

vi.mock('../../src/adapters/codex-auth.js', () => ({
  CodexAuth: class MockCodexAuth {
    getToken(): Promise<string> {
      return Promise.resolve('token');
    }

    clearCache(): void {}
  },
}));

type CodexModule = typeof import('../../src/adapters/codex.js');

interface WindowFixture {
  used_percent: number;
  reset_at: number;
  limit_window_seconds?: number;
}

function whamFixture(windows: {
  primary: WindowFixture;
  secondary?: WindowFixture | null;
  credits?: { has_credits: boolean; balance: string };
}): unknown {
  return {
    plan_type: 'plus',
    rate_limit: {
      primary_window: windows.primary,
      secondary_window: windows.secondary ?? null,
    },
    credits: windows.credits,
  };
}

describe('Codex.fetchUsage window mapping', () => {
  let Codex: CodexModule['Codex'];

  beforeEach(async () => {
    vi.resetModules();
    ({ Codex } = await import('../../src/adapters/codex.js'));
    fetchJsonWith.mockReset();
  });

  it('labels the primary window weekly while the 5h cap is removed', async () => {
    fetchJsonWith.mockResolvedValue(
      whamFixture({
        primary: { used_percent: 16.2, reset_at: 1_787_190_540, limit_window_seconds: 604_800 },
      }),
    );

    const provider = await new Codex().fetchUsage();

    expect(provider.error).toBeUndefined();
    expect(provider.models[0]?.windows.map((w) => w.label)).toEqual(['weekly']);
  });

  it('labels a restored 5h window from its length, in either slot', async () => {
    fetchJsonWith.mockResolvedValue(
      whamFixture({
        primary: { used_percent: 16.2, reset_at: 1_787_190_540, limit_window_seconds: 604_800 },
        secondary: { used_percent: 3.1, reset_at: 1_787_100_540, limit_window_seconds: 18_000 },
      }),
    );

    const provider = await new Codex().fetchUsage();
    const windows = provider.models[0]?.windows ?? [];

    expect(windows.map((w) => w.label)).toEqual(['5h', 'weekly']);
    expect(windows.map((w) => w.usedPercent)).toEqual([3.1, 16.2]);
    expect(windows.every((w) => w.resetAt != null)).toBe(true);
  });

  it('keeps the legacy slot fallback when no window length is present', async () => {
    fetchJsonWith.mockResolvedValue(
      whamFixture({
        primary: { used_percent: 16.2, reset_at: 1_787_190_540 },
        secondary: { used_percent: 3.1, reset_at: 1_787_100_540 },
      }),
    );

    const provider = await new Codex().fetchUsage();

    expect(provider.models[0]?.windows.map((w) => w.label)).toEqual(['5h', 'weekly']);
  });

  it('labels a monthly window and keeps the 5h → weekly → monthly order', async () => {
    fetchJsonWith.mockResolvedValue(
      whamFixture({
        primary: { used_percent: 97.5, reset_at: 1_787_190_540, limit_window_seconds: 2_592_000 },
        secondary: { used_percent: 3.1, reset_at: 1_787_100_540, limit_window_seconds: 18_000 },
      }),
    );

    const provider = await new Codex().fetchUsage();

    expect(provider.models[0]?.windows.map((w) => w.label)).toEqual(['5h', 'monthly']);
  });

  it('falls back to an hour-based label for an unknown window length', async () => {
    fetchJsonWith.mockResolvedValue(
      whamFixture({
        primary: { used_percent: 16.2, reset_at: 1_787_190_540, limit_window_seconds: 7_200 },
      }),
    );

    const provider = await new Codex().fetchUsage();

    expect(provider.models[0]?.windows.map((w) => w.label)).toEqual(['2h']);
  });

  it('appends credits last regardless of the rate-limit windows', async () => {
    fetchJsonWith.mockResolvedValue(
      whamFixture({
        primary: { used_percent: 16.2, reset_at: 1_787_190_540, limit_window_seconds: 604_800 },
        secondary: { used_percent: 3.1, reset_at: 1_787_100_540, limit_window_seconds: 18_000 },
        credits: { has_credits: true, balance: '5.25' },
      }),
    );

    const provider = await new Codex().fetchUsage();

    expect(provider.models[0]?.windows.map((w) => w.label)).toEqual(['5h', 'weekly', 'credits']);
  });
});
