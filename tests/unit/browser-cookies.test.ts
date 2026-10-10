import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

// Point the module-under-test at each test's fake endpoint. The getter keeps
// the override live without re-importing the already-parsed config module.
const cdpUrlRef = vi.hoisted(() => ({ url: '' }));

vi.mock('../../src/config.js', () => ({
  config: {
    LOG_LEVEL: 'silent',
    get CHROME_CDP_URL(): string | undefined {
      return cdpUrlRef.url === '' ? undefined : cdpUrlRef.url;
    },
  },
}));

import {
  evaluateInPage,
  navigateViaBrowser,
  parseCookiePairs,
  refreshCookiesViaBrowser,
  restoreCookiesViaBrowser,
} from '../../src/browser-cookies.js';

type Listener = (event: { data?: string }) => void;

const ALIBABA_OPTS = {
  domain: 'alibabacloud.com',
  cookieName: 'login_aliyunid_ticket',
  exactName: true,
} as const;

const FAIL_FAST_BUDGET_MS = 5_000;

// Mirrors NAVIGATION_TIMEOUT_MS in src/browser-cookies.ts.
const NAVIGATION_BUDGET_MS = 15_000;

// Two parseable cookies in the restore fixture.
const TWO_COOKIES = 2;

/**
 * WebSocket double for CDP frames. Records the URL it was opened with and the
 * raw command the client sent, then answers like Chrome's DevTools endpoint.
 * Native-WebSocket round-trips do not survive the vitest worker environment,
 * so the wire protocol is faked here while /json/list stays real HTTP.
 */
class FakeCdpSocket {
  static openedUrl = '';
  static sentCommand = '';
  static response: unknown = { cookies: [] };

  private listeners = new Map<string, Listener[]>();
  closed = false;

  constructor(url: string) {
    FakeCdpSocket.openedUrl = url;

    queueMicrotask(() => {
      this.emit('open', {});
    });
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(text: string): void {
    FakeCdpSocket.sentCommand = text;

    const command = JSON.parse(text) as { id: number; method: string };

    queueMicrotask(() => {
      this.emit('message', {
        data: JSON.stringify({ id: command.id, result: FakeCdpSocket.response }),
      });
    });
  }

  close(): void {
    this.closed = true;
  }

  protected emit(type: string, event: { data?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

/** Serve the DevTools HTTP discovery endpoints only. */
async function startFakeCdp(
  targets: Array<{ type: string; webSocketDebuggerUrl: string }>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ Browser: 'HeadlessChrome/149' }));
      return;
    }

    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(targets));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

/**
 * Socket double that answers the navigation conversation: Page.enable ok,
 * Page.navigate ok, then the Page.loadEventFired event as success signal.
 */
class FakeNavigatingSocket extends FakeCdpSocket {
  static commands: string[] = [];

  override send(text: string): void {
    FakeNavigatingSocket.commands.push(text);

    const command = JSON.parse(text) as { id: number; method: string };

    if (command.method === 'Page.navigate') {
      queueMicrotask(() => {
        this.emit('message', { data: JSON.stringify({ id: command.id, result: {} }) });
        this.emit('message', {
          data: JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 1 } }),
        });
      });
      return;
    }

    queueMicrotask(() => {
      this.emit('message', {
        data: JSON.stringify({ id: command.id, result: FakeCdpSocket.response }),
      });
    });
  }
}

/** Navigation double whose Page.navigate answer carries an errorText. */
class FakeNavigateErrorSocket extends FakeNavigatingSocket {
  override send(text: string): void {
    FakeNavigatingSocket.commands.push(text);

    const command = JSON.parse(text) as { id: number; method: string };

    if (command.method === 'Page.navigate') {
      queueMicrotask(() => {
        this.emit('message', {
          data: JSON.stringify({
            id: command.id,
            result: { errorText: 'net::ERR_NAME_NOT_RESOLVED' },
          }),
        });
      });
      return;
    }

    queueMicrotask(() => {
      this.emit('message', {
        data: JSON.stringify({ id: command.id, result: FakeCdpSocket.response }),
      });
    });
  }
}

/** Socket double that opens but never answers — for the hard-timeout path. */
class SilentSocket extends FakeCdpSocket {
  override send(): void {
    /* never answers */
  }
}

/** Socket double that answers every command with `{ success: true }`. */
class RecordingSetCookieSocket extends FakeCdpSocket {
  static commands: string[] = [];

  override send(text: string): void {
    RecordingSetCookieSocket.commands.push(text);

    const command = JSON.parse(text) as { id: number; method: string };

    queueMicrotask(() => {
      this.emit('message', {
        data: JSON.stringify({ id: command.id, result: { success: true } }),
      });
    });
  }
}

/** Socket double whose Network.setCookie answer reports rejection. */
class RejectingSetCookieSocket extends FakeCdpSocket {
  override send(text: string): void {
    const command = JSON.parse(text) as { id: number; method: string };

    queueMicrotask(() => {
      this.emit('message', {
        data: JSON.stringify({ id: command.id, result: { success: false } }),
      });
    });
  }
}

describe('parseCookiePairs', () => {
  it("splits a '; '-joined jar into name/value pairs", () => {
    expect(parseCookiePairs('a=1; b=2')).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
    ]);
  });

  it('trims whitespace around pairs and skips empty segments', () => {
    expect(parseCookiePairs('  a=1 ;   ;  b=2  ')).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
    ]);
  });

  it('splits at the first = only, so values may contain =', () => {
    expect(parseCookiePairs('t=x=y=z')).toEqual([{ name: 't', value: 'x=y=z' }]);
  });

  it('skips nameless and valueless segments', () => {
    expect(parseCookiePairs('=v; novalue; ok=1')).toEqual([{ name: 'ok', value: '1' }]);
  });
});

describe('restoreCookiesViaBrowser', () => {
  afterEach(() => {
    cdpUrlRef.url = '';
    vi.unstubAllGlobals();
  });

  it('sets every parsed cookie via Network.setCookie with the dot-domain params', async () => {
    const cdp = await startFakeCdp([
      { type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/abc' },
    ]);
    cdpUrlRef.url = cdp.url;
    vi.stubGlobal('WebSocket', RecordingSetCookieSocket);
    RecordingSetCookieSocket.commands = [];

    const ok = await restoreCookiesViaBrowser(
      'havana_tgc=ticket; login_aliyunid_ticket=x=y;  ; novalue; =empty',
      'alibabacloud.com',
    );

    expect(ok).toBe(true);
    expect(RecordingSetCookieSocket.commands).toHaveLength(TWO_COOKIES);
    expect(RecordingSetCookieSocket.commands[0]).toContain('"method":"Network.setCookie"');
    expect(RecordingSetCookieSocket.commands[0]).toContain('"domain":".alibabacloud.com"');
    expect(RecordingSetCookieSocket.commands[0]).toContain('"path":"/"');
    expect(RecordingSetCookieSocket.commands[0]).toContain('"secure":true');
    expect(RecordingSetCookieSocket.commands[0]).toContain('"httpOnly":true');
    expect(RecordingSetCookieSocket.commands[1]).toContain('"value":"x=y"');

    await cdp.close();
  });

  it('returns false when Chrome rejects one of the cookies', async () => {
    const cdp = await startFakeCdp([
      { type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/abc' },
    ]);
    cdpUrlRef.url = cdp.url;
    vi.stubGlobal('WebSocket', RejectingSetCookieSocket);

    const ok = await restoreCookiesViaBrowser('havana_tgc=ticket', 'alibabacloud.com');

    expect(ok).toBe(false);

    await cdp.close();
  });

  it('returns false instead of throwing when the CDP endpoint is unreachable', async () => {
    cdpUrlRef.url = 'http://127.0.0.1:9';

    const ok = await restoreCookiesViaBrowser('havana_tgc=ticket', 'alibabacloud.com');

    expect(ok).toBe(false);
  });
});

describe('navigateViaBrowser', () => {
  afterEach(() => {
    cdpUrlRef.url = '';
    vi.unstubAllGlobals();
  });

  it('enables the Page domain, navigates, and resolves on the load event', async () => {
    const cdp = await startFakeCdp([
      { type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/abc' },
    ]);
    cdpUrlRef.url = cdp.url;
    vi.stubGlobal('WebSocket', FakeNavigatingSocket);
    FakeNavigatingSocket.commands = [];

    const result = await navigateViaBrowser('https://modelstudio.console.alibabacloud.com/token');

    expect(result).toEqual({ ok: true });
    expect(FakeNavigatingSocket.commands).toHaveLength(2);
    expect(FakeNavigatingSocket.commands[0]).toContain('"method":"Page.enable"');
    expect(FakeNavigatingSocket.commands[1]).toContain('"method":"Page.navigate"');
    expect(FakeNavigatingSocket.commands[1]).toContain('modelstudio.console.alibabacloud.com');

    await cdp.close();
  });

  it('reports a Page.navigate errorText as a failed navigation', async () => {
    const cdp = await startFakeCdp([
      { type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/abc' },
    ]);
    cdpUrlRef.url = cdp.url;
    vi.stubGlobal('WebSocket', FakeNavigateErrorSocket);
    FakeNavigatingSocket.commands = [];

    const result = await navigateViaBrowser('https://modelstudio.console.alibabacloud.com/token');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('net::ERR_NAME_NOT_RESOLVED');

    await cdp.close();
  });

  it('times out when the page never finishes loading', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      let socketArmed = false;

      class TrackedSilentSocket extends SilentSocket {
        constructor(url: string) {
          super(url);
          socketArmed = true;
        }
      }

      const cdp = await startFakeCdp([
        { type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/abc' },
      ]);
      cdpUrlRef.url = cdp.url;
      vi.stubGlobal('WebSocket', TrackedSilentSocket);

      const pending = navigateViaBrowser('https://modelstudio.console.alibabacloud.com/token');

      // Yield on real event-loop turns until the DevTools socket (and with it
      // the 15s timeout) exists on the fake clock at t=0 — the discovery HTTP
      // fetches settle during these yields.
      while (!socketArmed) {
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
      }

      await vi.advanceTimersByTimeAsync(NAVIGATION_BUDGET_MS);

      await expect(pending).resolves.toEqual({
        ok: false,
        error: expect.stringContaining('navigation timed out'),
      });

      await cdp.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails when no page target exists', async () => {
    const cdp = await startFakeCdp([
      { type: 'browser', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/xyz' },
    ]);
    cdpUrlRef.url = cdp.url;
    vi.stubGlobal('WebSocket', FakeNavigatingSocket);

    const result = await navigateViaBrowser('https://modelstudio.console.alibabacloud.com/token');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('no page target');

    await cdp.close();
  });

  it('fails fast when the CDP endpoint is unreachable', async () => {
    cdpUrlRef.url = 'http://127.0.0.1:9';

    const result = await navigateViaBrowser('https://modelstudio.console.alibabacloud.com/token');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Chrome not found');
  });
});

describe('refreshCookiesViaBrowser', () => {
  afterEach(() => {
    cdpUrlRef.url = '';
    vi.unstubAllGlobals();
  });

  it('reads domain-filtered cookies via raw CDP and exact-validates the required name', async () => {
    const cdp = await startFakeCdp([
      { type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/abc' },
    ]);
    cdpUrlRef.url = cdp.url;
    vi.stubGlobal('WebSocket', FakeCdpSocket);
    FakeCdpSocket.response = {
      cookies: [
        { name: 'login_aliyunid_ticket', value: 'ticket-1', domain: '.alibabacloud.com' },
        { name: 'unrelated', value: 'x', domain: 'example.com' },
      ],
    };

    const result = await refreshCookiesViaBrowser(ALIBABA_OPTS);

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('cdp');
    expect(result.cookieString).toBe('login_aliyunid_ticket=ticket-1');

    await cdp.close();
  });

  it('rewrites the advertised websocket origin to the reachable CDP endpoint', async () => {
    const cdp = await startFakeCdp([
      { type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/abc' },
    ]);
    cdpUrlRef.url = cdp.url;
    vi.stubGlobal('WebSocket', FakeCdpSocket);
    FakeCdpSocket.response = { cookies: [] };

    await refreshCookiesViaBrowser(ALIBABA_OPTS);

    // Chrome inside a container advertises its own loopback origin; the client
    // must connect to the bridge it actually reached via /json/list instead.
    expect(FakeCdpSocket.openedUrl).toContain(cdp.url.replace('http', 'ws'));
    expect(FakeCdpSocket.sentCommand).toContain('"method":"Network.getAllCookies"');

    await cdp.close();
  });

  it('prefix-validates the required cookie when exactName is not set', async () => {
    const cdp = await startFakeCdp([
      { type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/abc' },
    ]);
    cdpUrlRef.url = cdp.url;
    vi.stubGlobal('WebSocket', FakeCdpSocket);
    FakeCdpSocket.response = {
      cookies: [{ name: '__client_U', value: 's', domain: '.context7.com' }],
    };

    const result = await refreshCookiesViaBrowser();

    expect(result.ok).toBe(true);
    expect(result.cookieString).toBe('__client_U=s');

    await cdp.close();
  });

  it('reports a missing login instead of timing out when the required cookie is absent', async () => {
    const cdp = await startFakeCdp([
      { type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/abc' },
    ]);
    cdpUrlRef.url = cdp.url;
    vi.stubGlobal('WebSocket', FakeCdpSocket);
    FakeCdpSocket.response = {
      cookies: [{ name: 'other', value: 'v', domain: '.alibabacloud.com' }],
    };

    const result = await refreshCookiesViaBrowser(ALIBABA_OPTS);

    expect(result.ok).toBe(false);
    expect(result.cookieString).toBe('other=v');
    expect(result.error).toContain('login_aliyunid_ticket');

    await cdp.close();
  });

  it('fails with a clear error when no page target exists', async () => {
    const cdp = await startFakeCdp([
      { type: 'browser', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/xyz' },
    ]);
    cdpUrlRef.url = cdp.url;
    vi.stubGlobal('WebSocket', FakeCdpSocket);

    const result = await refreshCookiesViaBrowser(ALIBABA_OPTS);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('no page target');

    await cdp.close();
  });

  it('surfaces a CDP protocol error from the DevTools socket', async () => {
    const cdp = await startFakeCdp([
      { type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/abc' },
    ]);
    cdpUrlRef.url = cdp.url;
    vi.stubGlobal(
      'WebSocket',
      class extends FakeCdpSocket {
        send(text: string): void {
          const command = JSON.parse(text) as { id: number };

          queueMicrotask(() => {
            this.emit('message', {
              data: JSON.stringify({ id: command.id, error: { message: 'not attached' } }),
            });
          });
        }
      },
    );

    const result = await refreshCookiesViaBrowser(ALIBABA_OPTS);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('not attached');

    await cdp.close();
  });

  it('fails fast when the endpoint is unreachable instead of hanging like Playwright did', async () => {
    cdpUrlRef.url = 'http://127.0.0.1:9';

    const startedAt = Date.now();
    const result = await refreshCookiesViaBrowser(ALIBABA_OPTS);
    const elapsedMs = Date.now() - startedAt;

    expect(result.ok).toBe(false);
    expect(result.mode).toBe('cdp');
    expect(result.error).toContain('Chrome not found');
    // The Playwright path stalled for tens of seconds; the raw client must stay bounded.
    expect(elapsedMs).toBeLessThan(FAIL_FAST_BUDGET_MS);
  });
});

describe('evaluateInPage', () => {
  afterEach(() => {
    cdpUrlRef.url = '';
    vi.unstubAllGlobals();
  });

  it('awaits the in-page expression and returns its by-value result', async () => {
    const cdp = await startFakeCdp([
      { type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/abc' },
    ]);
    cdpUrlRef.url = cdp.url;
    vi.stubGlobal('WebSocket', FakeCdpSocket);
    FakeCdpSocket.response = { result: { type: 'string', value: '{"json":{}}' } };

    const value = await evaluateInPage('fetch("/grant").then(r=>r.text())');

    expect(value).toBe('{"json":{}}');
    expect(FakeCdpSocket.sentCommand).toContain('"method":"Runtime.evaluate"');
    expect(FakeCdpSocket.sentCommand).toContain('"awaitPromise":true');
    expect(FakeCdpSocket.sentCommand).toContain('"returnByValue":true');

    await cdp.close();
  });

  it('rejects when the expression threw inside the page', async () => {
    const cdp = await startFakeCdp([
      { type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/abc' },
    ]);
    cdpUrlRef.url = cdp.url;
    vi.stubGlobal('WebSocket', FakeCdpSocket);
    FakeCdpSocket.response = {
      result: { type: 'object', subtype: 'error' },
      exceptionDetails: { text: 'TypeError: fetch is not a function' },
    };

    await expect(evaluateInPage('nope()')).rejects.toThrow('Runtime.evaluate threw in the page');

    await cdp.close();
  });

  it('fails fast when the CDP endpoint is unreachable', async () => {
    cdpUrlRef.url = 'http://127.0.0.1:9';

    await expect(evaluateInPage('1')).rejects.toThrow('Chrome not found');
  });
});
