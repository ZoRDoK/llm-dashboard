/**
 * Browser-based cookie refresher for sites whose session cookies are HttpOnly
 * and therefore cannot be read from `document.cookie`.
 *
 * The ONLY reliable way to obtain such cookies is to connect to the user's
 * actual Chrome via Chrome DevTools Protocol (CDP), where the HttpOnly cookies
 * already exist.
 *
 * Usage:
 *   Start Chrome with:  google-chrome --remote-debugging-port=9222
 *   Then this module connects to it and extracts fresh cookies.
 *
 * The endpoint is configurable via the CHROME_CDP_URL env var (config.ts),
 * which may point at scripts/cdp-proxy.mjs when the logged-in Chrome runs
 * inside a container.
 *
 * Raw CDP only: Playwright's connectOverCDP was observed to complete its
 * websocket handshake against containerized Chromium and then hang until
 * timeout, so this module speaks the protocol directly over Node's native
 * WebSocket — GET /json/list, open the first page target's DevTools socket,
 * then either send Network.getAllCookies (cookie refresh) or drive
 * Page.enable + Page.navigate (silent-SSO keepalive) — with hard timeouts on
 * every step.
 */
import { z } from 'zod';

import { config } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('cookies');

const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';
const PORT_CHECK_TIMEOUT_MS = 1_000;
const CDP_HTTP_TIMEOUT_MS = 3_000;
const CDP_WS_TIMEOUT_MS = 5_000;
// A navigation has to wait out every redirect hop of the console SSO chain,
// so its budget is deliberately larger than a plain CDP command's.
const NAVIGATION_TIMEOUT_MS = 15_000;
const PAGE_TARGET_TYPE = 'page';
const CDP_COMMAND_ID = 1;

const PAGE_ENABLE_COMMAND = 'Page.enable';
const PAGE_NAVIGATE_COMMAND = 'Page.navigate';
const PAGE_LOAD_EVENT = 'Page.loadEventFired';
const SET_COOKIE_COMMAND = 'Network.setCookie';
const COOKIE_SEPARATOR = ';';
const COOKIE_ASSIGN = '=';

/** One `name=value` pair of a cookie header. */
interface CookiePair {
  name: string;
  value: string;
}

interface RefreshCookiesOptions {
  /** Substring matched against cookie `domain`. Default: 'context7.com'. */
  domain?: string;
  /** Validate that a cookie with this name exists. Default prefix-match '__client'. */
  cookieName?: string;
  /** Match `cookieName` exactly instead of as a prefix. Default: false. */
  exactName?: boolean;
  /** CDP endpoint of a specific browser profile. Default: CHROME_CDP_URL. */
  cdpUrl?: string;
}

interface BrowserCookieResult {
  ok: boolean;
  cookieString: string | null;
  mode: 'cdp' | 'none';
  error?: string;
}

/** One DevTools /json/list entry — only page targets accept Network commands. */
const CdpTargetsSchema = z.array(
  z.object({
    type: z.string(),
    webSocketDebuggerUrl: z.string(),
  }),
);

const CdpCookieEntrySchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
});

type CdpCookie = z.infer<typeof CdpCookieEntrySchema>;

/** Chrome answers Network.getAllCookies with `{ cookies: [...] }`. */
const CdpCookiesSchema = z.object({ cookies: z.array(CdpCookieEntrySchema) });

/**
 * Envelope of any CDP websocket message. `id` correlates a command with its
 * response; events (e.g. Page.loadEventFired) arrive without an id.
 */
interface CdpResponse {
  id?: number;
  method?: string;
  error?: { message: string };
  result?: unknown;
}

/** Chrome answers Page.navigate with `{ frameId, errorText? }`. */
const NavigateResultSchema = z.object({ errorText: z.string().optional() });

/** Chrome answers Network.setCookie with `{ success }` (omitted on old builds). */
const SetCookieResultSchema = z.object({ success: z.boolean().optional() });

/** Handle one scripted CDP conversation; `done` settles it exactly once. */
interface CdpSession {
  send: (method: string, params?: Record<string, unknown>) => void;
  done: (err: Error | null, result?: unknown) => void;
}

/** Caller-provided behavior and error texts of one CDP conversation. */
interface CdpConversation {
  timeoutError: Error;
  closedError: Error;
  onOpen: (session: CdpSession) => void;
  onMessage: (session: CdpSession, message: CdpResponse) => void;
}

/**
 * Try to obtain fresh cookies for the configured domain.
 *
 * Strategy:
 *   1. Try CDP — connect to the user's Chrome (must be started with
 *      `--remote-debugging-port=${CDP_PORT}`).  This is the only method
 *      that yields HttpOnly cookies.
 *   2. If CDP is unavailable, return null.  The caller should fall back
 *      to cached data.
 */
export async function refreshCookiesViaBrowser(
  opts: RefreshCookiesOptions = {},
): Promise<BrowserCookieResult> {
  try {
    const cdpResult = await tryCdp(opts);

    if (cdpResult.ok && cdpResult.cookieString) {
      return cdpResult;
    }

    // Keep the CDP-mode failure (missing login, no page target, …) — callers
    // match on it to decide between "log in" hints and stale-cache fallback.
    return cdpResult;
  } catch (err) {
    log.warn({ err: err instanceof Error ? err : new Error(String(err)) }, 'CDP error');
  }

  return { ok: false, cookieString: null, mode: 'none', error: 'No browser available' };
}

/**
 * Navigate the first page target to `url` in the user's real Chrome so the
 * site's silent SSO chain can run (long-lived cookies mint a fresh session
 * ticket with no user action). The caller then re-extracts the refreshed
 * cookies via refreshCookiesViaBrowser.
 */
export async function navigateViaBrowser(
  url: string,
  cdpUrl: string = config.CHROME_CDP_URL ?? DEFAULT_CDP_URL,
): Promise<{ ok: boolean; error?: string }> {
  const alive = await checkCdpEndpoint(cdpUrl);

  if (!alive) {
    return {
      ok: false,
      error: `Chrome not found at ${cdpUrl}. Start Chrome with: google-chrome --remote-debugging-port=9222 (or point CHROME_CDP_URL at it)`,
    };
  }

  try {
    const wsUrl = await firstPageTargetWsUrl(cdpUrl);

    await navigateViaCdp(wsUrl, url);

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Split a `; `-joined cookie header into trimmed name/value pairs. Empty
 * segments and segments with no name (nothing before `=`) are skipped; values
 * may themselves contain `=`.
 */
export function parseCookiePairs(cookieString: string): CookiePair[] {
  const pairs: CookiePair[] = [];

  for (const segment of cookieString.split(COOKIE_SEPARATOR)) {
    const pair = segment.trim();
    const assignAt = pair.indexOf(COOKIE_ASSIGN);

    if (assignAt <= 0) {
      continue; // empty segment or an empty cookie name
    }

    pairs.push({ name: pair.slice(0, assignAt), value: pair.slice(assignAt + 1) });
  }

  return pairs;
}

/**
 * Push a persisted cookie jar back into the user's Chrome via CDP so a
 * browser that lost its profile (recreated container) regains the saved
 * session — e.g. the havana_tgc SSO ticket of the Alibaba console. Cookies
 * are set sequentially on `.{domain}`; no navigation happens. Returns true
 * only when every cookie was accepted; any failure logs one warn and returns
 * false, leaving the caller's normal refresh flow in charge.
 */
export async function restoreCookiesViaBrowser(
  cookieString: string,
  domain: string,
): Promise<boolean> {
  const cdpUrl = config.CHROME_CDP_URL ?? DEFAULT_CDP_URL;

  try {
    const alive = await checkCdpEndpoint(cdpUrl);

    if (!alive) {
      throw new Error(`Chrome not found at ${cdpUrl}`);
    }

    const wsUrl = await firstPageTargetWsUrl(cdpUrl);

    for (const { name, value } of parseCookiePairs(cookieString)) {
      const result = SetCookieResultSchema.parse(
        await sendCdpCommand(wsUrl, SET_COOKIE_COMMAND, {
          name,
          value,
          domain: `.${domain}`,
          path: '/',
          secure: true,
          httpOnly: true,
        }),
      );

      if (result.success === false) {
        throw new Error(`${SET_COOKIE_COMMAND} rejected cookie ${name}`);
      }
    }

    return true;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err : new Error(String(err)) },
      'Cookie restore into Chrome failed',
    );

    return false;
  }
}

/**
 * Connect to the user's Chrome via CDP and extract fresh cookies
 * without navigating or opening tabs (non-intrusive).
 */
async function tryCdp(opts: RefreshCookiesOptions): Promise<BrowserCookieResult> {
  const cdpUrl = opts.cdpUrl ?? config.CHROME_CDP_URL ?? DEFAULT_CDP_URL;

  const alive = await checkCdpEndpoint(cdpUrl);

  if (!alive) {
    return {
      ok: false,
      cookieString: null,
      mode: 'cdp',
      error: `Chrome not found at ${cdpUrl}. Start Chrome with: google-chrome --remote-debugging-port=9222 (or point CHROME_CDP_URL at it)`,
    };
  }

  let allCookies: CdpCookie[];

  try {
    allCookies = await fetchBrowserCookies(cdpUrl);
  } catch (err) {
    return {
      ok: false,
      cookieString: null,
      mode: 'cdp',
      error: `CDP cookie read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const domain = opts.domain ?? 'context7.com';
  const cookieName = opts.cookieName ?? '__client';

  const matchingCookies = allCookies.filter((c) => c.domain.includes(domain));

  const cookieString = matchingCookies.map((c) => `${c.name}=${c.value}`).join('; ');

  // Validate the required cookie exists — exact match or prefix match.
  const hasRequired = opts.exactName
    ? matchingCookies.some((c) => c.name === cookieName)
    : matchingCookies.some((c) => c.name.startsWith(cookieName));

  if (!hasRequired) {
    return {
      ok: false,
      cookieString,
      mode: 'cdp',
      error: `No ${cookieName} cookie found — are you logged into the target site?`,
    };
  }

  return { ok: true, cookieString, mode: 'cdp' };
}

/** Resolve the DevTools websocket of the first page target for a CDP session. */
async function firstPageTargetWsUrl(cdpUrl: string): Promise<string> {
  const targets = CdpTargetsSchema.parse(await fetchCdpJson(`${cdpUrl}/json/list`));

  const page = targets.find((t) => t.type === PAGE_TARGET_TYPE);

  if (!page) {
    throw new Error('no page target found — open a tab in Chrome');
  }

  return proxiedWsUrl(page.webSocketDebuggerUrl, cdpUrl);
}

/** Read every browser cookie via the first page target's DevTools websocket. */
async function fetchBrowserCookies(cdpUrl: string): Promise<CdpCookie[]> {
  const wsUrl = await firstPageTargetWsUrl(cdpUrl);

  const result = CdpCookiesSchema.parse(await sendCdpCommand(wsUrl, 'Network.getAllCookies'));

  return result.cookies;
}

/** GET a DevTools JSON endpoint with a hard timeout. */
async function fetchCdpJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(CDP_HTTP_TIMEOUT_MS) });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from DevTools endpoint`);
  }

  return (await response.json()) as unknown;
}

/**
 * Chrome advertises websocket URLs on its own loopback origin (a container
 * reports its internal 127.0.0.1:9222), which is unreachable from the host
 * when a bridge like scripts/cdp-proxy.mjs sits in between. Rewrite the
 * origin to the endpoint /json/list was successfully fetched from.
 */
function proxiedWsUrl(wsUrl: string, cdpUrl: string): string {
  const target = new URL(wsUrl);
  const base = new URL(cdpUrl);
  const scheme = base.protocol === 'https:' ? 'wss:' : 'ws:';

  return `${scheme}//${base.host}${target.pathname}${target.search}`;
}

/**
 * Send one CDP command over Node's native WebSocket and await its response.
 * Every failure mode (no open, no answer, protocol error) is bounded by a
 * hard timeout so a hung DevTools socket cannot stall the refresh loop;
 * `timeoutMs` widens that bound for commands that await in-page work
 * (Runtime.evaluate) instead of a plain DevTools round trip.
 */
function sendCdpCommand(
  wsUrl: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs: number = CDP_WS_TIMEOUT_MS,
): Promise<unknown> {
  return runCdpSession(wsUrl, method, timeoutMs, {
    timeoutError: new Error(`CDP ${method} timed out after ${timeoutMs}ms`),
    closedError: new Error(`CDP ${method}: socket closed before a response`),
    onOpen: (session) => {
      session.send(method, params);
    },
    onMessage: (session, message) => {
      if (message.id !== CDP_COMMAND_ID) {
        return; // CDP events we did not ask for
      }

      if (message.error) {
        session.done(new Error(`CDP ${method} error: ${message.error.message}`));
        return;
      }

      session.done(null, message.result);
    },
  });
}

/**
 * Navigate the page target to `url` over one DevTools socket: enable the Page
 * domain, issue Page.navigate, then wait for Page.loadEventFired. Silent-SSO
 * redirects are part of the same navigation, so the single load completion
 * proves the redirected console session finished loading.
 */
function navigateViaCdp(wsUrl: string, url: string): Promise<unknown> {
  let pageEnabled = false;

  return runCdpSession(wsUrl, 'navigation', NAVIGATION_TIMEOUT_MS, {
    timeoutError: new Error(`navigation timed out after ${NAVIGATION_TIMEOUT_MS}ms`),
    closedError: new Error('CDP navigation: socket closed before the page finished loading'),
    onOpen: (session) => {
      session.send(PAGE_ENABLE_COMMAND);
    },
    onMessage: (session, message) => {
      // Events carry no id: the load event is the success signal.
      if (message.id === undefined) {
        if (message.method === PAGE_LOAD_EVENT) {
          session.done(null);
        }

        return;
      }

      if (message.error) {
        session.done(new Error(`CDP navigation command error: ${message.error.message}`));
        return;
      }

      // Page.enable answered — only now fire the actual navigation.
      if (!pageEnabled) {
        pageEnabled = true;
        session.send(PAGE_NAVIGATE_COMMAND, { url });
        return;
      }

      // Page.navigate answered: a non-empty errorText reports a failed load.
      const { errorText } = NavigateResultSchema.parse(message.result ?? {});

      if (errorText) {
        session.done(new Error(`CDP ${PAGE_NAVIGATE_COMMAND} errorText: ${errorText}`));
      }
    },
  });
}

/**
 * Open one DevTools websocket and hand a scripted conversation to the plan.
 * Every failure mode (no open, no answer, protocol error) is bounded by a
 * hard timeout so a hung DevTools socket cannot stall the caller; the socket
 * is always torn down once the session settles.
 */
function runCdpSession(
  wsUrl: string,
  label: string,
  timeoutMs: number,
  plan: CdpConversation,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    let nextCommandId = CDP_COMMAND_ID;

    // Settle exactly once, then always tear the socket down.
    const done = (err: Error | null, result?: unknown): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      ws.close();

      if (err) {
        reject(err);
        return;
      }

      resolve(result);
    };

    const timer = setTimeout(() => {
      done(plan.timeoutError);
    }, timeoutMs);

    const session: CdpSession = {
      send: (method, params = {}) => {
        ws.send(JSON.stringify({ id: nextCommandId, method, params }));
        nextCommandId += 1;
      },
      done,
    };

    ws.addEventListener('open', () => {
      plan.onOpen(session);
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      let message: CdpResponse;

      try {
        message = JSON.parse(String(event.data)) as CdpResponse;
      } catch {
        done(new Error(`CDP ${label}: malformed websocket message`));
        return;
      }

      plan.onMessage(session, message);
    });

    ws.addEventListener('error', () => {
      done(new Error(`CDP websocket failed: ${wsUrl}`));
    });

    ws.addEventListener('close', () => {
      done(plan.closedError);
    });
  });
}

/** Quick HTTP check that a Chrome DevTools endpoint answers /json/version. */
async function checkCdpEndpoint(cdpUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${cdpUrl}/json/version`, {
      signal: AbortSignal.timeout(PORT_CHECK_TIMEOUT_MS),
    });

    return response.ok;
  } catch {
    return false;
  }
}

// ── Browser-level CDP (window activation) ───────────────────

const BROWSER_SESSION_TIMEOUT_MS = 8_000;

/** Chrome answers /json/version with the browser-level DevTools socket. */
const CdpVersionSchema = z.object({ webSocketDebuggerUrl: z.string() });

const CdpTargetsListSchema = z.object({
  targetInfos: z.array(z.object({ targetId: z.string(), type: z.string() })),
});

type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

/**
 * Run a scripted conversation against the browser-level DevTools socket.
 * Unlike page sockets, browser sessions answer Target.* commands with
 * request/response ids instead of events.
 */
function withBrowserSession<T>(wsUrl: string, run: (send: CdpSend) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let ws: WebSocket;
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (err: Error) => void }
    >();
    let nextId = CDP_COMMAND_ID;

    const finish = (err: Error | null, value?: T): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      for (const waiter of pending.values()) {
        waiter.reject(err ?? new Error('CDP browser session closed'));
      }

      pending.clear();

      try {
        ws.close();
      } catch {
        // already closing
      }

      if (err) {
        reject(err);
      } else {
        resolve(value as T);
      }
    };

    const timer = setTimeout(
      () => finish(new Error('CDP browser session timed out')),
      BROWSER_SESSION_TIMEOUT_MS,
    );

    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const send: CdpSend = (method, params = {}) => {
      const id = nextId;
      nextId += 1;

      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id, method, params }));
      });
    };

    ws.addEventListener('message', (event: MessageEvent) => {
      let message: { id?: number; result?: unknown; error?: { message: string } };

      try {
        message = JSON.parse(String(event.data)) as typeof message;
      } catch {
        finish(new Error('CDP browser session: malformed message'));
        return;
      }

      if (message.id == null) {
        return;
      }

      const waiter = pending.get(message.id);

      if (!waiter) {
        return;
      }

      pending.delete(message.id);

      if (message.error) {
        waiter.reject(new Error(message.error.message));
      } else {
        waiter.resolve(message.result);
      }
    });

    ws.addEventListener('error', () => finish(new Error(`CDP websocket failed: ${wsUrl}`)));
    ws.addEventListener('close', () => finish(new Error('CDP browser session closed')));

    ws.addEventListener('open', () => {
      run(send).then(
        (value) => finish(null, value),
        (err: unknown) => finish(err instanceof Error ? err : new Error(String(err))),
      );
    });
  });
}

/** Resolve the browser-level DevTools socket for a CDP endpoint. */
async function browserSocketUrl(cdpUrl: string): Promise<string> {
  const response = await fetch(`${cdpUrl}/json/version`, {
    signal: AbortSignal.timeout(CDP_HTTP_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`CDP version endpoint HTTP ${response.status}`);
  }

  const info = CdpVersionSchema.parse(await response.json());

  return proxiedWsUrl(info.webSocketDebuggerUrl, cdpUrl);
}

/**
 * Navigate the profile's page to `url` and raise its window.
 *
 * The dedicated window is already there when Chrome was started by the
 * service or the operator; Target.activateTarget is what brings it to the
 * front instead of leaving a silently navigated background tab.
 */
export async function openProfileWindow(
  cdpUrl: string,
  url: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const wsUrl = await browserSocketUrl(cdpUrl);
    const page = await withBrowserSession(wsUrl, async (send) => {
      const targets = CdpTargetsListSchema.parse(await send('Target.getTargets'));

      return targets.targetInfos.find((target) => target.type === PAGE_TARGET_TYPE) ?? null;
    });

    if (page) {
      const navigation = await navigateViaBrowser(url, cdpUrl);

      if (!navigation.ok) {
        return navigation;
      }

      await withBrowserSession(wsUrl, (send) =>
        send('Target.activateTarget', { targetId: page.targetId }),
      );

      return { ok: true };
    }

    await withBrowserSession(wsUrl, async (send) => {
      const created = (await send('Target.createTarget', { url })) as { targetId: string };

      await send('Target.activateTarget', { targetId: created.targetId });
    });

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
