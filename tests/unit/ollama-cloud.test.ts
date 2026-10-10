import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({
  LOG_LEVEL: 'silent' as const,
  OLLAMA_CLOUD_API_KEY: 'osk-test-key' as string | undefined,
}));

vi.mock('../../src/config.js', () => ({ config: settings }));

const fetchAndParse = vi.hoisted(() => vi.fn());

vi.mock('../../src/fetch-utils.js', () => ({ fetchAndParse }));

type OllamaCloudModule = typeof import('../../src/adapters/ollama-cloud.js');
type FetchAndParse = typeof import('../../src/fetch-utils.js').fetchAndParse;

/** Mock signature: real fetchAndParse shape plus the vitest methods used here. */
type FetchAndParseMock = FetchAndParse & {
  mockResolvedValue(value: unknown): void;
  mockReset(): void;
};

const fetchAndParseMock = fetchAndParse as FetchAndParseMock;

const TEST_API_KEY = 'osk-test-key';
const USAGE_ENDPOINT = 'https://ollama.com/api/usage';

// Session usage ratio 0, weekly 0.008 → 0.8% — mirrors the live response shape.
const USAGE_FIXTURE = {
  activity: {
    cost: '0.00000',
    period: {
      type: 'last_4_weeks',
      starting_at: '2026-09-01T00:00:00Z',
      ending_at: '2026-09-29T00:00:00Z',
    },
    models: [],
  },
  limits: {
    session: { usage: 0, models: [] },
    weekly: { usage: 0.008, models: [{ name: 'web search', request_count: 1 }] },
  },
};

const ROUND_RATIO = 0.1234;
const ROUND_PERCENT = 12.3;

// Expected fixture-derived percents (ratio × 100).
const SESSION_REMAINING_PERCENT = 100;
const WEEKLY_USED_PERCENT = 0.8;
const WEEKLY_REMAINING_PERCENT = 99.2;

describe('OllamaCloud.fetchUsage', () => {
  let OllamaCloud: OllamaCloudModule['OllamaCloud'];

  beforeEach(async () => {
    vi.resetModules();
    ({ OllamaCloud } = await import('../../src/adapters/ollama-cloud.js'));
    fetchAndParseMock.mockReset();
    settings.OLLAMA_CLOUD_API_KEY = TEST_API_KEY;
  });

  it('maps session and weekly usage ratios into labeled windows', async () => {
    fetchAndParseMock.mockResolvedValue(USAGE_FIXTURE);

    const provider = await new OllamaCloud().fetchUsage();
    const windows = provider.models[0]?.windows ?? [];

    expect(provider.error).toBeUndefined();
    expect(provider.plan).toBe('Cloud');
    expect(provider.models).toHaveLength(1);
    expect(provider.models[0]?.modelName).toBe('Cloud Usage');

    expect(windows).toHaveLength(2);
    expect(windows[0]?.label).toBe('5h');
    expect(windows[0]?.usedPercent).toBe(0);
    expect(windows[0]?.remainingPercent).toBe(SESSION_REMAINING_PERCENT);
    expect(windows[0]?.resetAt).toBeNull();

    expect(windows[1]?.label).toBe('weekly');
    expect(windows[1]?.usedPercent).toBe(WEEKLY_USED_PERCENT);
    expect(windows[1]?.remainingPercent).toBe(WEEKLY_REMAINING_PERCENT);
    expect(windows[1]?.resetAt).toBeNull();
  });

  it('fetches the usage endpoint with the API key and the usage schema', async () => {
    const { UsageSchema } = await import('../../src/adapters/ollama-cloud.js');
    fetchAndParseMock.mockResolvedValue(USAGE_FIXTURE);

    await new OllamaCloud().fetchUsage();

    expect(fetchAndParseMock).toHaveBeenCalledTimes(1);
    expect(fetchAndParseMock).toHaveBeenCalledWith(USAGE_ENDPOINT, TEST_API_KEY, UsageSchema);
  });

  it('returns a not-configured provider without fetching when no key is set', async () => {
    settings.OLLAMA_CLOUD_API_KEY = undefined;

    try {
      const provider = await new OllamaCloud().fetchUsage();

      expect(provider.plan).toBe('Not configured');
      expect(provider.models).toHaveLength(0);
      expect(fetchAndParseMock).not.toHaveBeenCalled();
    } finally {
      settings.OLLAMA_CLOUD_API_KEY = TEST_API_KEY;
    }
  });

  it('rounds usage ratios to one decimal percent', () => {
    const windows = new OllamaCloud().parseWindows({
      limits: { session: { usage: ROUND_RATIO }, weekly: { usage: 0 } },
    });

    expect(windows[0]?.label).toBe('5h');
    expect(windows[0]?.usedPercent).toBe(ROUND_PERCENT);
    expect(windows[1]?.usedPercent).toBe(0);
  });
});
