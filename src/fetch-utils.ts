/**
 * Typed fetch helpers shared by adapters.
 *
 * All helpers time out after {@link FETCH_TIMEOUT_MS} by default; a trailing
 * `timeoutMs` argument overrides the budget per call. They throw
 * `HTTP <status>` on non-OK responses. Transient network-level failures are
 * retried with a short bounded backoff inside {@link fetchRaw} (see its WHY
 * note). Adapters keep building their own headers so custom auth schemes
 * (cookies, beta headers, gRPC-web) stay explicit at the call site.
 */
import type { ZodType } from 'zod';

import { FETCH_TIMEOUT_MS } from './constants.js';
import { createLogger } from './logger.js';

const log = createLogger('fetch');

/** Total attempts per fetch: the initial try plus retries. */
const FETCH_ATTEMPTS = 3;
/** Delay before the first retry; doubles per retry (2s, then 4s; ≤6s extra sleep). */
const RETRY_BACKOFF_START_MS = 2_000;
/** How deep to walk an error `cause` chain hunting for a retryable code. */
const MAX_CAUSE_DEPTH = 3;

/** Network-level codes that signal a transient failure worth retrying. */
const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Decide whether a thrown error is a transient network-level failure worth
 * retrying: a retryable code on the error itself, anywhere in its `cause`
 * chain, inside an AggregateError's members — or a TimeoutError from an
 * expired AbortSignal. Non-Error values are never transient.
 */
function isTransientNetworkError(err: unknown): boolean {
  let current: unknown = err;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) {
      return false;
    }

    if (current.name === 'TimeoutError') {
      return true;
    }

    const code = (current as { code?: unknown }).code;

    if (typeof code === 'string' && TRANSIENT_ERROR_CODES.has(code)) {
      return true;
    }

    if (current instanceof AggregateError && current.errors.some(isTransientNetworkError)) {
      return true;
    }

    current = current.cause;
  }

  return false;
}

/** First error code (or error name) along the cause chain, for retry logs. */
function errorCode(err: unknown): string {
  let current: unknown = err;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) {
      return 'unknown';
    }

    const code = (current as { code?: unknown }).code;

    if (typeof code === 'string') {
      return code;
    }

    if (current.name === 'TimeoutError') {
      return current.name;
    }

    current = current.cause;
  }

  return err instanceof Error ? err.name : 'unknown';
}

/**
 * Fetch with a timeout budget and a bounded retry for transient network
 * failures only — HTTP error statuses are never retried (the server answered).
 *
 * WHY: after a laptop suspend/resume, Wi-Fi needs a few seconds to reconnect
 * and the first fetches fail with ETIMEDOUT/ECONNRESET/TimeoutError. Without
 * a retry, a slow-cycle adapter (10min tick) loses its whole slot to one
 * blip; a 2s→4s backoff heals the tick within the same cycle.
 */
export async function fetchRaw(
  url: string,
  init: RequestInit,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<Response> {
  let lastError: unknown;
  let backoffMs = RETRY_BACKOFF_START_MS;

  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    // Backoff sleeps sit between retries only — never delay the first attempt.
    if (attempt > 1) {
      await sleep(backoffMs);
      backoffMs *= 2;
    }

    try {
      return await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        ...init,
      });
    } catch (err) {
      if (!isTransientNetworkError(err)) {
        throw err;
      }

      lastError = err;

      // URL, headers, and body stay out of the log: only the retry shape.
      if (attempt < FETCH_ATTEMPTS) {
        log.debug(
          { attempt, maxAttempts: FETCH_ATTEMPTS, code: errorCode(err) },
          'Transient network error, retrying fetch',
        );
      }
    }
  }

  throw lastError;
}

/** Fetch with a timeout budget; throw `HTTP <status>` on non-OK responses. */
async function fetchOk(
  url: string,
  init: RequestInit,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const response = await fetchRaw(url, init, timeoutMs);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response;
}

/** Fetch JSON from a custom-headers URL (cookies, bearer, beta headers). */
export async function fetchJsonWith(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<unknown> {
  const response = await fetchOk(url, { headers }, timeoutMs);

  return (await response.json()) as unknown;
}

/** Fetch text (HTML/NDJSON) from a custom-headers URL. */
export async function fetchText(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<string> {
  const response = await fetchOk(url, { headers }, timeoutMs);

  return await response.text();
}

/** POST a form-urlencoded body to an API that answers JSON. */
export async function postFormJson(
  url: string,
  headers: Record<string, string>,
  body: URLSearchParams,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<unknown> {
  const response = await fetchOk(url, { method: 'POST', headers, body }, timeoutMs);

  return (await response.json()) as unknown;
}

/**
 * Fetch JSON from a Bearer-token API.
 *
 * Sends `Authorization: Bearer {apiKey}`, `Accept`, and `Content-Type` headers.
 * Throws on non-OK response. Times out after {@link FETCH_TIMEOUT_MS}.
 *
 * NOTE: This function uses Bearer auth. Adapters using cookies or
 * custom auth schemes (e.g. Codex, Mimo, OllamaCloud, Context7)
 * implement their own fetch logic.
 */
export async function fetchJson(endpoint: string, apiKey: string): Promise<unknown> {
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  return await fetchJsonWith(endpoint, headers);
}

/** Fetch JSON from a Bearer-token API and validate it against a zod schema. */
export async function fetchAndParse<T>(
  endpoint: string,
  apiKey: string,
  schema: ZodType<T>,
): Promise<T> {
  const raw = await fetchJson(endpoint, apiKey);

  return schema.parse(raw);
}
