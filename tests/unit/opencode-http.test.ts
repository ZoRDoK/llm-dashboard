import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchOpenCodeApi } from '../../src/adapters/opencode-http.js';

const SESSION_COOKIE = 'test-cookie';
const WORKSPACE_ID = 'wrk_test';
const API_PATH = '/go/status';
const EXPECTED_URL = `https://opencode.ai/console/api${API_PATH}`;
const STATUS_OK = 200;
const STATUS_FOUND = 302;
const STATUS_UNAUTHORIZED = 401;
const STATUS_SERVER_ERROR = 500;
const SESSION_EXPIRED_ERROR = 'Session expired, re-authenticate required';

const STATUS_BODY = { subscriberUserId: 'acc_1', useBalance: false };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: STATUS_OK,
    headers: { 'content-type': 'application/json' },
  });
}

function redirectResponse(location: string): Response {
  return new Response(null, {
    status: STATUS_FOUND,
    headers: { location },
  });
}

function errorResponse(status: number): Response {
  return new Response(null, { status });
}

const originalFetch = globalThis.fetch;

describe('fetchOpenCodeApi', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('requests the console API URL with the session cookie, org header, and manual redirects', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(jsonResponse(STATUS_BODY));
    globalThis.fetch = fetchMock;

    await fetchOpenCodeApi(SESSION_COOKIE, WORKSPACE_ID, API_PATH);

    const [url, init] = fetchMock.mock.calls[0];

    expect(url).toBe(EXPECTED_URL);
    expect(init?.redirect).toBe('manual');
    expect(init?.headers).toEqual({
      cookie: `__Host-console_session=${SESSION_COOKIE}`,
      'x-org-id': WORKSPACE_ID,
      'user-agent': expect.any(String),
    });
  });

  it('rejects with the session-expired error on 401', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(errorResponse(STATUS_UNAUTHORIZED));
    globalThis.fetch = fetchMock;

    await expect(fetchOpenCodeApi(SESSION_COOKIE, WORKSPACE_ID, API_PATH)).rejects.toThrow(
      SESSION_EXPIRED_ERROR,
    );
  });

  it('rejects with the session-expired error on a console/login redirect', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(redirectResponse('https://opencode.ai/console/login'));
    globalThis.fetch = fetchMock;

    await expect(fetchOpenCodeApi(SESSION_COOKIE, WORKSPACE_ID, API_PATH)).rejects.toThrow(
      SESSION_EXPIRED_ERROR,
    );
  });

  it('rejects with the session-expired error on an /auth/authorize redirect', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(redirectResponse('/auth/authorize'));
    globalThis.fetch = fetchMock;

    await expect(fetchOpenCodeApi(SESSION_COOKIE, WORKSPACE_ID, API_PATH)).rejects.toThrow(
      SESSION_EXPIRED_ERROR,
    );
  });

  it('rejects an unexpected redirect with its status and location', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(redirectResponse('/somewhere-else'));
    globalThis.fetch = fetchMock;

    await expect(fetchOpenCodeApi(SESSION_COOKIE, WORKSPACE_ID, API_PATH)).rejects.toThrow(
      'HTTP 302 -> /somewhere-else',
    );
  });

  it('rejects a non-OK response with its status', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(errorResponse(STATUS_SERVER_ERROR));
    globalThis.fetch = fetchMock;

    await expect(fetchOpenCodeApi(SESSION_COOKIE, WORKSPACE_ID, API_PATH)).rejects.toThrow(
      'HTTP 500',
    );
  });

  it('resolves with the parsed JSON body', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(jsonResponse(STATUS_BODY));
    globalThis.fetch = fetchMock;

    const result = await fetchOpenCodeApi(SESSION_COOKIE, WORKSPACE_ID, API_PATH);

    expect(result).toEqual(STATUS_BODY);
  });
});
