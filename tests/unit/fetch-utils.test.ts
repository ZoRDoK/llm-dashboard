import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJson, fetchRaw } from '../../src/fetch-utils.js';

const ENDPOINT = 'https://api.example.com/usage';
const API_KEY = 'secret-key';
const STATUS_OK = 200;
const STATUS_SERVER_ERROR = 500;
// Mirrors the module-private retry constants in src/fetch-utils.ts.
const RETRY_BACKOFF_START_MS = 2_000;
const FETCH_ATTEMPTS = 3;
// Total backoff sleep across both retries: 2s + 4s (start value doubles per retry).
const TOTAL_BACKOFF_MS = 6_000;

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: STATUS_OK,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number): Response {
  return new Response(null, { status });
}

/** Undici-style network failure: TypeError wrapping a retryable cause code. */
function transientError(): TypeError {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect failed'), { code: 'ECONNRESET' }),
  });
}

const originalFetch = globalThis.fetch;

describe('fetchJson', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends Bearer auth headers and returns parsed JSON on success', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    globalThis.fetch = fetchMock;

    const result = await fetchJson(ENDPOINT, API_KEY);

    expect(result).toEqual({ ok: true });
    const init = fetchMock.mock.calls[0][1];
    expect(init?.headers).toEqual({
      Accept: 'application/json',
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    });
  });

  it('throws an HTTP status error on a non-OK response', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(errorResponse(STATUS_SERVER_ERROR));
    globalThis.fetch = fetchMock;

    await expect(fetchJson(ENDPOINT, API_KEY)).rejects.toThrow('HTTP 500');
  });

  it('configures an AbortSignal timeout on the request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(okResponse({}));
    globalThis.fetch = fetchMock;

    await fetchJson(ENDPOINT, API_KEY);

    const init = fetchMock.mock.calls[0][1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('propagates a network rejection to the caller', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockRejectedValue(new Error('network down'));
    globalThis.fetch = fetchMock;

    await expect(fetchJson(ENDPOINT, API_KEY)).rejects.toThrow('network down');
  });

  it('propagates an abort (timeout) rejection to the caller', async () => {
    let captured: AbortSignal | undefined;
    const fetchMock = vi.fn<typeof fetch>((_input, init) => {
      captured = init?.signal ?? undefined;

      return new Promise<Response>((_resolve, reject) => {
        captured?.addEventListener('abort', () => {
          reject(new Error('The operation was aborted due to timeout'));
        });
      });
    });
    globalThis.fetch = fetchMock;

    const promise = fetchJson(ENDPOINT, API_KEY);

    // Simulate AbortSignal.timeout firing by dispatching the abort event.
    captured?.dispatchEvent(new Event('abort'));

    await expect(promise).rejects.toThrow('aborted');
  });
});

describe('fetchRaw', () => {
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it('retries once and succeeds after a transient network failure', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockRejectedValueOnce(transientError());
    fetchMock.mockResolvedValueOnce(okResponse({ ok: true }));
    globalThis.fetch = fetchMock;

    vi.useFakeTimers();
    const pending = fetchRaw(ENDPOINT, { headers: {} });

    // Cross the single 2s backoff between attempt 1 and attempt 2.
    await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_START_MS);

    const response = await pending;

    expect(response.status).toBe(STATUS_OK);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after the bounded attempt count on persistent transient failures', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(transientError());
    globalThis.fetch = fetchMock;

    vi.useFakeTimers();
    // Attach the rejection expectation up front so the final failure is never unhandled.
    const settled = expect(fetchRaw(ENDPOINT, { headers: {} })).rejects.toThrow('fetch failed');

    // Cross both backoff sleeps (2s + 4s) before the final attempt fails.
    await vi.advanceTimersByTimeAsync(TOTAL_BACKOFF_MS);

    await settled;
    expect(fetchMock).toHaveBeenCalledTimes(FETCH_ATTEMPTS);
  });

  it('does not retry an HTTP error status because the server answered', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(errorResponse(STATUS_SERVER_ERROR));
    globalThis.fetch = fetchMock;

    await expect(fetchJson(ENDPOINT, API_KEY)).rejects.toThrow('HTTP 500');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry errors that are not transient network failures', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('boom'));
    globalThis.fetch = fetchMock;

    await expect(fetchRaw(ENDPOINT, {})).rejects.toThrow('boom');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a TimeoutError raised by an expired request signal', async () => {
    const timeoutError = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockRejectedValueOnce(timeoutError);
    fetchMock.mockResolvedValueOnce(okResponse({}));
    globalThis.fetch = fetchMock;

    vi.useFakeTimers();
    const pending = fetchRaw(ENDPOINT, { headers: {} });

    await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_START_MS);

    const response = await pending;

    expect(response.status).toBe(STATUS_OK);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
