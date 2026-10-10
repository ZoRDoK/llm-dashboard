import { describe, expect, it, vi } from 'vitest';

import { buildWeekWindows, withNetworkRetry } from '../../src/adapters/alibaba-qwen.js';

// Direct helper tests keep the retry delay at the minimum so the suite stays fast.
const FAST_RETRY_MS = 1;

describe('buildWeekWindows', () => {
  it('converts the weekly usage fraction to a percent window with reset time', () => {
    const windows = buildWeekWindows({
      per1WeekResetTime: 1_787_190_540_000,
      per1WeekPercentage: 0.77583101891665,
    });

    expect(windows).toHaveLength(1);

    const win = windows[0];

    expect(win.label).toBe('weekly');

    // biome-ignore lint/style/noMagicNumbers: expected percent derived from the fixture fraction
    expect(win.usedPercent).toBe(77.6);

    // biome-ignore lint/style/noMagicNumbers: remaining = 100 - used
    expect(win.remainingPercent).toBe(22.4);
    expect(win.resetAt).toBe('2026-08-20T01:49:00.000Z');
  });

  it('clamps usage above one full quota to 100%', () => {
    const [win] = buildWeekWindows({
      per1WeekResetTime: 1_787_190_540_000,
      per1WeekPercentage: 1.25,
    });

    // biome-ignore lint/style/noMagicNumbers: clamped ceiling
    expect(win.usedPercent).toBe(100);
  });

  it('clamps negative usage to 0%', () => {
    const [win] = buildWeekWindows({
      per1WeekResetTime: 1_787_190_540_000,
      per1WeekPercentage: -0.5,
    });

    expect(win.usedPercent).toBe(0);
  });

  it('yields resetAt null when the post-reset payload omits the reset time', () => {
    const [win] = buildWeekWindows({ per1WeekPercentage: 0 });

    expect(win.usedPercent).toBe(0);
    expect(win.resetAt).toBeNull();
  });

  it('treats an explicit null reset time the same as an omitted one', () => {
    const [win] = buildWeekWindows({ per1WeekResetTime: null, per1WeekPercentage: 0.5 });

    // biome-ignore lint/style/noMagicNumbers: half of the quota in percent
    expect(win.usedPercent).toBe(50);
    expect(win.resetAt).toBeNull();
  });
});

describe('withNetworkRetry', () => {
  it('retries exactly once after a network-level TypeError and succeeds', async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce('ok');

    await expect(withNetworkRetry(op, FAST_RETRY_MS)).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('reports the cause code and preserves the retry error when both attempts fail', async () => {
    const retryErr = new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    const op = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }))
      .mockRejectedValueOnce(retryErr);

    let caught: unknown;

    try {
      await withNetworkRetry(op, FAST_RETRY_MS);
    } catch (err) {
      caught = err;
    }

    expect((caught as Error).message).toBe('fetch failed (ECONNRESET)');
    expect((caught as Error).cause).toBe(retryErr);
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('falls back to a generic code when the network TypeError carries no cause', async () => {
    const op = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    await expect(withNetworkRetry(op, FAST_RETRY_MS)).rejects.toThrow(
      'fetch failed (network error)',
    );
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('does not retry a timeout — a slow endpoint answered, it is not down', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const op = vi.fn().mockRejectedValue(timeout);

    await expect(withNetworkRetry(op, FAST_RETRY_MS)).rejects.toBe(timeout);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('does not retry an HTTP-level error — the endpoint answered', async () => {
    const http = new Error('HTTP 401');
    const op = vi.fn().mockRejectedValue(http);

    await expect(withNetworkRetry(op, FAST_RETRY_MS)).rejects.toBe(http);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('propagates a non-network failure of the retry unchanged', async () => {
    const http = new Error('HTTP 503');
    const op = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(http);

    await expect(withNetworkRetry(op, FAST_RETRY_MS)).rejects.toBe(http);
    expect(op).toHaveBeenCalledTimes(2);
  });
});
