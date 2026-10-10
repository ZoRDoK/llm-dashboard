import { CHROME_USER_AGENT, FETCH_TIMEOUT_MS } from '../constants.js';
import { fetchRaw } from '../fetch-utils.js';

const SESSION_EXPIRED_ERROR = 'Session expired, re-authenticate required';

/** Login path fragments an expired session redirects to. */
const LOGIN_REDIRECT_PATHS = ['/auth/authorize', '/console/login'];

/** 3xx status range; `redirect: 'manual'` surfaces these instead of following them. */
const REDIRECT_STATUS_MIN = 300;
const REDIRECT_STATUS_MAX = 400;

/** 401 from the console API means the session cookie expired. */
const HTTP_UNAUTHORIZED = 401;

const CONSOLE_API_BASE_URL = 'https://opencode.ai/console/api';

/** True when a redirect target points at a login page rather than an API response. */
function isLoginRedirect(location: string): boolean {
  return LOGIN_REDIRECT_PATHS.some((path) => location.includes(path));
}

/**
 * Fetch a console API path with the `__Host-console_session` cookie value, the
 * `x-org-id` workspace header, and a Chrome user-agent.
 *
 * WHY: opencode.ai moved from SSR workspace pages to a Vite SPA at `/console/{id}`
 * that talks to this JSON API, so HTML scraping of `/workspace/{id}` is dead.
 * The old `auth` cookie is rejected by the API (401) — only the console session
 * cookie is sent.
 *
 * Redirects are requested in manual mode so an expired session stays visible:
 * a login redirect throws the session-expired error, any other redirect throws
 * `HTTP <status> -> <location>`, and a non-OK response throws `HTTP <status>`.
 * Times out after {@link FETCH_TIMEOUT_MS}.
 */
export async function fetchOpenCodeApi(
  sessionCookie: string,
  workspaceId: string,
  apiPath: string,
): Promise<unknown> {
  const url = `${CONSOLE_API_BASE_URL}${apiPath}`;

  const headers = {
    cookie: `__Host-console_session=${sessionCookie}`,
    'x-org-id': workspaceId,
    'user-agent': CHROME_USER_AGENT,
  };

  const response = await fetchRaw(url, { headers, redirect: 'manual' });

  if (response.status === HTTP_UNAUTHORIZED) {
    throw new Error(SESSION_EXPIRED_ERROR);
  }

  if (response.status >= REDIRECT_STATUS_MIN && response.status < REDIRECT_STATUS_MAX) {
    const location = response.headers.get('location') ?? '';

    if (isLoginRedirect(location)) {
      throw new Error(SESSION_EXPIRED_ERROR);
    }

    throw new Error(`HTTP ${response.status} -> ${location}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return await response.json();
}
