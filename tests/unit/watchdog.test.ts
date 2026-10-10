import { describe, expect, it, vi } from 'vitest';
import { config } from '../../src/config.js';
import { MS_PER_HOUR, MS_PER_MINUTE } from '../../src/constants.js';
import type { WatchdogAlertRow, WatchdogRunRow, WatchdogRunStatus } from '../../src/store.js';
import type { LogEntry, ProviderMetrics } from '../../src/types.js';
import type { SpawnOptions, WatchdogManagerApi, WatchdogStoreApi } from '../../src/watchdog.js';
import { classifyNeedsHuman, formatLag, isStale, localDay, Watchdog } from '../../src/watchdog.js';

// The default notifier must never reach real notify-send from tests; the
// notification behavior is covered through the injected-notify tests below.
vi.mock('../../src/notify.js', () => ({ desktopNotify: vi.fn() }));

// ── Constants ───────────────────────────────────────────────

const NOW = 1_780_000_000_000;
const STALE_MS = config.WATCHDOG_STALE_HOURS * MS_PER_HOUR;
const GAP_MINUTES = 61;
const HALF_GAP_MINUTES = 30;
const GAP_OK_MS = GAP_MINUTES * MS_PER_MINUTE;
const HALF_GAP_MS = HALF_GAP_MINUTES * MS_PER_MINUTE;
const FAKE_PID = 12_345;
// Practically-dead pid: above any default pid_max, so kill() throws ESRCH.
const DEAD_PID = 4_000_000;
const RESOLVED_AT = 9_999;
const RECENT_LIMIT = 5;
const THREE_TIMES = 3;
const TWICE = 2;
const FIVE_MIN = 5;
const THREE_POINT_TWO_HOURS = 3.2;
const FORTY_EIGHT_HOURS = 48;

// ── Fakes ───────────────────────────────────────────────────

interface FakeRun {
  id: number;
  day: string;
  startedAt: number;
  finishedAt: number | null;
  status: string;
  providers: string[];
  pid: number | null;
}

interface FakeAlert {
  id: number;
  kind: string;
  providerId: string | null;
  message: string;
  createdAt: number;
  resolvedAt: number | null;
}

function toRunRow(run: FakeRun): WatchdogRunRow {
  return {
    id: run.id,
    day: run.day,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    status: run.status as WatchdogRunStatus,
    providers: [...run.providers],
    pid: run.pid,
  };
}

function toAlertRow(alert: FakeAlert): WatchdogAlertRow {
  return { ...alert, kind: alert.kind as WatchdogAlertRow['kind'] } as WatchdogAlertRow;
}

/** In-memory implementation of the watchdog slice of ProviderStore. */
class FakeStore implements WatchdogStoreApi {
  runs: FakeRun[] = [];
  alerts: FakeAlert[] = [];
  private nextRunId = 1;
  private nextAlertId = 1;

  addWatchdogRun(day: string, startedAt: number, providers: string[], pid: number | null): number {
    const id = this.nextRunId++;

    this.runs.push({ id, day, startedAt, finishedAt: null, status: 'running', providers, pid });

    return id;
  }

  setWatchdogRunPid(id: number, pid: number): void {
    const run = this.runs.find((r) => r.id === id);

    if (run) {
      run.pid = pid;
    }
  }

  finishWatchdogRun(id: number, status: string, finishedAt: number): void {
    const run = this.runs.find((r) => r.id === id);

    if (run) {
      run.status = status;
      run.finishedAt = finishedAt;
    }
  }

  getRunningWatchdogRuns(): WatchdogRunRow[] {
    return this.runs.filter((r) => r.status === 'running').map(toRunRow);
  }

  getRecentWatchdogRuns(limit: number): WatchdogRunRow[] {
    return [...this.runs]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
      .map(toRunRow);
  }

  countWatchdogRunsForDay(day: string): number {
    return this.runs.filter((r) => r.day === day).length;
  }

  openWatchdogAlert(
    kind: string,
    providerId: string | null,
    message: string,
    createdAt: number,
  ): void {
    this.alerts.push({
      id: this.nextAlertId++,
      kind,
      providerId,
      message,
      createdAt,
      resolvedAt: null,
    });
  }

  getOpenWatchdogAlerts(): WatchdogAlertRow[] {
    return this.alerts.filter((a) => a.resolvedAt === null).map(toAlertRow);
  }

  resolveWatchdogAlert(kind: string, providerId: string | null): void {
    for (const alert of this.alerts) {
      if (alert.kind === kind && alert.providerId === providerId && alert.resolvedAt === null) {
        alert.resolvedAt = RESOLVED_AT;
      }
    }
  }

  resolveAllOpenWatchdogAlerts(): void {
    for (const alert of this.alerts) {
      if (alert.resolvedAt === null) {
        alert.resolvedAt = RESOLVED_AT;
      }
    }
  }
}

function makeManager(metrics: ProviderMetrics[], logs: LogEntry[]): WatchdogManagerApi {
  return { getMetrics: () => metrics, getLogs: () => logs };
}

interface RecordedSpawn {
  command: string;
  args: string[];
  opts: SpawnOptions;
}

function makeRecorder(pid: number): {
  spawns: RecordedSpawn[];
  spawnCmd: (command: string, args: string[], opts: SpawnOptions) => { pid: number };
} {
  const spawns: RecordedSpawn[] = [];

  const spawnCmd = (command: string, args: string[], opts: SpawnOptions) => {
    spawns.push({ command, args, opts });

    return { pid };
  };

  return { spawns, spawnCmd };
}

// ── Fixtures ────────────────────────────────────────────────

interface MetricOverrides {
  lastSuccessAt?: number | null;
  lastAttemptAt?: number | null;
  configured?: boolean;
  archived?: boolean;
}

function metric(id: string, name: string, overrides: MetricOverrides = {}): ProviderMetrics {
  return {
    id,
    name,
    archived: overrides.archived ?? false,
    configured: overrides.configured ?? true,
    lastSuccessAt: overrides.lastSuccessAt ?? null,
    lastAttemptAt: overrides.lastAttemptAt ?? null,
  };
}

function errorLog(providerId: string, message: string): LogEntry {
  return { ts: NOW, level: 'error', message, providerId };
}

function infoLog(providerId: string, message: string): LogEntry {
  return { ts: NOW, level: 'info', message, providerId };
}

const LOGIN_ERROR = 'Brave session expired — update BRAVE_COOKIE';
const FIXABLE_ERROR = 'kimi update failed: HTTP 500';

/** One stale fixable provider (kimi) + one stale needs-human provider (brave). */
function mixedStaleManager(): WatchdogManagerApi {
  const metrics = [
    metric('kimi', 'Kimi', { lastSuccessAt: NOW - STALE_MS - MS_PER_MINUTE }),
    metric('brave', 'Brave', { lastSuccessAt: NOW - STALE_MS - MS_PER_MINUTE }),
    metric('zai', 'Zai', { lastSuccessAt: NOW - MS_PER_MINUTE }),
  ];
  const logs = [errorLog('kimi', FIXABLE_ERROR), errorLog('brave', LOGIN_ERROR)];

  return makeManager(metrics, logs);
}

function makeWatchdog(manager: WatchdogManagerApi): {
  watchdog: Watchdog;
  store: FakeStore;
  spawns: RecordedSpawn[];
} {
  const store = new FakeStore();
  const { spawns, spawnCmd } = makeRecorder(FAKE_PID);
  const watchdog = new Watchdog({ store, manager, spawnCmd, now: () => NOW });

  return { watchdog, store, spawns };
}

// ── Pure helpers ────────────────────────────────────────────

describe('classifyNeedsHuman', () => {
  it('classifies every real human-auth error message as needs-human', () => {
    const messages = [
      'Session expired, re-authenticate required',
      'Console session expired — log in again in Chrome at modelstudio.console.alibabacloud.com',
      'Brave session expired — update BRAVE_COOKIE',
      'Start Chrome with --remote-debugging-port=9222 and log into context7.com, or set CONTEXT7_SESSION_COOKIE',
      'No __client cookie found — are you logged into the target site?',
      'Not configured',
    ];

    for (const message of messages) {
      expect(classifyNeedsHuman(message), message).toBe(true);
    }
  });

  it('classifies fixable errors as not needs-human', () => {
    expect(classifyNeedsHuman('kimi update failed: HTTP 500')).toBe(false);
    expect(classifyNeedsHuman('scrape returned no rows')).toBe(false);
  });

  it('returns false for empty error', () => {
    expect(classifyNeedsHuman(null)).toBe(false);
    expect(classifyNeedsHuman('')).toBe(false);
  });
});

describe('isStale', () => {
  it('is not stale exactly at the threshold', () => {
    expect(isStale(STALE_MS, STALE_MS)).toBe(false);
  });

  it('is stale just past the threshold', () => {
    expect(isStale(STALE_MS + 1, STALE_MS)).toBe(true);
  });
});

describe('localDay', () => {
  it('formats a YYYY-MM-DD local day key', () => {
    expect(localDay(NOW)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(localDay(NOW)).toBe(new Date(NOW).toLocaleDateString('sv'));
  });
});

describe('formatLag', () => {
  it('formats minutes, hours and days', () => {
    expect(formatLag(FIVE_MIN * MS_PER_MINUTE)).toBe('5m behind');
    expect(formatLag(THREE_POINT_TWO_HOURS * MS_PER_HOUR)).toBe('3.2h behind');
    expect(formatLag(FORTY_EIGHT_HOURS * MS_PER_HOUR)).toBe('2d behind');
  });
});

// ── tick: detection and alerts ──────────────────────────────

describe('Watchdog.tick — detection', () => {
  it('flags only configured, non-archived, over-threshold providers', () => {
    const metrics = [
      metric('stale-ok', 'Stale', { lastSuccessAt: NOW - STALE_MS - 1 }),
      metric('at-threshold', 'At', { lastSuccessAt: NOW - STALE_MS }),
      metric('fresh', 'Fresh', { lastSuccessAt: NOW - MS_PER_MINUTE }),
      metric('archived', 'Archived', { lastSuccessAt: NOW - STALE_MS - 1, archived: true }),
      metric('unconfigured', 'Unconf', { lastSuccessAt: NOW - STALE_MS - 1, configured: false }),
    ];
    const { watchdog } = makeWatchdog(makeManager(metrics, []));

    const data = watchdog.getPanelData();

    expect(data.problems.map((p) => p.providerId)).toEqual(['stale-ok']);
  });

  it('uses the last warn/error log line as the error text', () => {
    const metrics = [metric('kimi', 'Kimi', { lastSuccessAt: NOW - STALE_MS - 1 })];
    const logs = [
      { ts: NOW - 1, level: 'info', message: 'Kimi updated', providerId: 'kimi' },
      { ts: NOW, level: 'warn', message: FIXABLE_ERROR, providerId: 'kimi' },
    ] satisfies LogEntry[];
    const { watchdog } = makeWatchdog(makeManager(metrics, logs));

    const data = watchdog.getPanelData();

    expect(data.problems[0]?.error).toBe(FIXABLE_ERROR);
    expect(data.problems[0]?.needsHuman).toBe(false);
  });
});

// ── tick: auth-only detection ─────────────────────────────

describe('Watchdog.tick — auth-only detection', () => {
  it('flags a fresh-attempt provider whose newest log is an auth error', () => {
    // brave retries every minute, so lag is tiny and it never looks stale.
    const metrics = [
      metric('brave', 'Brave', { lastAttemptAt: NOW - MS_PER_MINUTE, lastSuccessAt: null }),
    ];
    const { watchdog } = makeWatchdog(makeManager(metrics, [errorLog('brave', LOGIN_ERROR)]));

    const data = watchdog.getPanelData();

    expect(data.problems).toHaveLength(1);
    expect(data.problems[0]?.providerId).toBe('brave');
    expect(data.problems[0]?.needsHuman).toBe(true);
    expect(data.problems[0]?.error).toBe(LOGIN_ERROR);
    expect(data.problems[0]?.lagMs).toBe(MS_PER_MINUTE);
  });

  it('flags an unconfigured provider whose newest log says not configured', () => {
    const metrics = [metric('context7', 'Context7', { configured: false })];
    const { watchdog } = makeWatchdog(
      makeManager(metrics, [infoLog('context7', 'Context7 not configured')]),
    );

    const data = watchdog.getPanelData();

    expect(data.problems).toHaveLength(1);
    expect(data.problems[0]?.providerId).toBe('context7');
    expect(data.problems[0]?.needsHuman).toBe(true);
    expect(data.problems[0]?.error).toBe('Context7 not configured');
  });

  it('does not flag a provider whose newest log is a normal success line', () => {
    const metrics = [
      metric('zai', 'Zai', { lastAttemptAt: NOW - MS_PER_MINUTE, lastSuccessAt: null }),
    ];
    const { watchdog } = makeWatchdog(makeManager(metrics, [infoLog('zai', 'Zai updated')]));

    const data = watchdog.getPanelData();

    expect(data.problems).toHaveLength(0);
  });

  it('reports a provider that is both stale and auth-erroring exactly once', () => {
    const metrics = [metric('brave', 'Brave', { lastSuccessAt: NOW - STALE_MS - 1 })];
    const { watchdog } = makeWatchdog(makeManager(metrics, [errorLog('brave', LOGIN_ERROR)]));

    const data = watchdog.getPanelData();

    const brave = data.problems.filter((p) => p.providerId === 'brave');

    expect(brave).toHaveLength(1);
    expect(brave[0]?.needsHuman).toBe(true);
  });

  it('opens a login-required alert for an auth-only provider without launching', () => {
    const metrics = [
      metric('brave', 'Brave', { lastAttemptAt: NOW - MS_PER_MINUTE, lastSuccessAt: null }),
    ];
    const { watchdog, store, spawns } = makeWatchdog(
      makeManager(metrics, [errorLog('brave', LOGIN_ERROR)]),
    );

    watchdog.tick(NOW);

    expect(spawns).toHaveLength(0);
    expect(store.getOpenWatchdogAlerts().map((a) => a.providerId)).toEqual(['brave']);
  });
});

describe('Watchdog.tick — alerts', () => {
  it('never launches for needs-human staleness, but opens a login-required alert', () => {
    const metrics = [metric('brave', 'Brave', { lastSuccessAt: NOW - STALE_MS - 1 })];
    const { watchdog, store, spawns } = makeWatchdog(
      makeManager(metrics, [errorLog('brave', LOGIN_ERROR)]),
    );

    watchdog.tick(NOW);

    expect(spawns).toHaveLength(0);

    const open = store.getOpenWatchdogAlerts();

    expect(open).toHaveLength(1);
    expect(open[0]?.kind).toBe('login-required');
    expect(open[0]?.providerId).toBe('brave');
  });

  it('dedupes the login-required alert across ticks', () => {
    const metrics = [metric('brave', 'Brave', { lastSuccessAt: NOW - STALE_MS - 1 })];
    const { watchdog, store } = makeWatchdog(
      makeManager(metrics, [errorLog('brave', LOGIN_ERROR)]),
    );

    watchdog.tick(NOW);
    watchdog.tick(NOW + MS_PER_MINUTE);

    const loginAlerts = store.alerts.filter((a) => a.kind === 'login-required');

    expect(loginAlerts).toHaveLength(1);
  });

  it('resolves the login-required alert when the provider recovers', () => {
    const staleMetrics = [metric('brave', 'Brave', { lastSuccessAt: NOW - STALE_MS - 1 })];
    const { watchdog, store } = makeWatchdog(
      makeManager(staleMetrics, [errorLog('brave', LOGIN_ERROR)]),
    );

    watchdog.tick(NOW);

    const freshMetrics = [metric('brave', 'Brave', { lastSuccessAt: NOW - MS_PER_MINUTE })];
    const recovered = new Watchdog({
      store,
      manager: makeManager(freshMetrics, []),
      now: () => NOW,
    });

    recovered.tick(NOW);

    expect(store.getOpenWatchdogAlerts()).toHaveLength(0);
  });

  it('resolves all open alerts when every provider is fresh', () => {
    const staleMetrics = [
      metric('kimi', 'Kimi', { lastSuccessAt: NOW - STALE_MS - MS_PER_HOUR }),
      metric('brave', 'Brave', { lastSuccessAt: NOW - STALE_MS - MS_PER_HOUR }),
    ];
    const { watchdog, store } = makeWatchdog(
      makeManager(staleMetrics, [errorLog('kimi', FIXABLE_ERROR), errorLog('brave', LOGIN_ERROR)]),
    );

    watchdog.tick(NOW);
    watchdog.tick(NOW + GAP_OK_MS);
    watchdog.tick(NOW + TWICE * GAP_OK_MS);

    expect(store.alerts.length).toBeGreaterThan(0);

    const freshMetrics = [metric('kimi', 'Kimi', { lastSuccessAt: NOW })];
    const recovered = new Watchdog({
      store,
      manager: makeManager(freshMetrics, []),
      now: () => NOW,
    });

    recovered.tick(NOW);

    expect(store.getOpenWatchdogAlerts()).toHaveLength(0);
  });
});

// ── tick: desktop notification ───────────────────────────

describe('Watchdog — desktop notification', () => {
  interface RecordedNotify {
    title: string;
    body: string;
  }

  function makeNotifyingWatchdog(manager: WatchdogManagerApi): {
    watchdog: Watchdog;
    notifications: RecordedNotify[];
  } {
    const notifications: RecordedNotify[] = [];
    const { spawnCmd } = makeRecorder(FAKE_PID);

    const watchdog = new Watchdog({
      store: new FakeStore(),
      manager,
      spawnCmd,
      notify: (title, body) => {
        notifications.push({ title, body });
      },
      now: () => NOW,
    });

    return { watchdog, notifications };
  }

  it('fires the injected notifier exactly once when a login-required alert opens', () => {
    const metrics = [metric('brave', 'Brave', { lastSuccessAt: NOW - STALE_MS - 1 })];
    const { watchdog, notifications } = makeNotifyingWatchdog(
      makeManager(metrics, [errorLog('brave', LOGIN_ERROR)]),
    );

    watchdog.tick(NOW);
    watchdog.tick(NOW + MS_PER_MINUTE);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.title).toBe('AI Creds: login required');
    expect(notifications[0]?.body).toBe(`Brave: ${LOGIN_ERROR}`);
  });

  it('never notifies for fixable problems', () => {
    const metrics = [metric('kimi', 'Kimi', { lastSuccessAt: NOW - STALE_MS - 1 })];
    const { watchdog, notifications } = makeNotifyingWatchdog(
      makeManager(metrics, [errorLog('kimi', FIXABLE_ERROR)]),
    );

    watchdog.tick(NOW);

    expect(notifications).toHaveLength(0);
  });

  it('notifies again when the alert reopens after a recovery', () => {
    const store = new FakeStore();
    const { spawnCmd } = makeRecorder(FAKE_PID);
    const notifications: RecordedNotify[] = [];
    let metrics: ProviderMetrics[] = [
      metric('brave', 'Brave', { lastSuccessAt: NOW - STALE_MS - 1 }),
    ];
    let logs: LogEntry[] = [errorLog('brave', LOGIN_ERROR)];

    const watchdog = new Watchdog({
      store,
      manager: { getMetrics: () => metrics, getLogs: () => logs },
      spawnCmd,
      notify: (title, body) => {
        notifications.push({ title, body });
      },
      now: () => NOW,
    });

    watchdog.tick(NOW);
    expect(notifications).toHaveLength(1);

    // Session recovers, the login-required alert resolves.
    metrics = [metric('brave', 'Brave', { lastSuccessAt: NOW - MS_PER_MINUTE })];
    logs = [];
    watchdog.tick(NOW + MS_PER_MINUTE);
    expect(notifications).toHaveLength(1);

    // The session breaks again: a new alert opens and notifies once more.
    metrics = [metric('brave', 'Brave', { lastSuccessAt: NOW - STALE_MS - 1 })];
    logs = [errorLog('brave', LOGIN_ERROR)];
    watchdog.tick(NOW + TWICE * MS_PER_MINUTE);

    expect(notifications).toHaveLength(TWICE);
  });
});

// ── tick: launching ─────────────────────────────────────────

describe('Watchdog.tick — launch', () => {
  it('launches an agent for fixable stale providers and records the run with pid', () => {
    const { watchdog, store, spawns } = makeWatchdog(mixedStaleManager());

    watchdog.tick(NOW);

    expect(spawns).toHaveLength(1);

    const [spawned] = spawns;

    expect(spawned?.command).toBe(config.WATCHDOG_PI_PATH);
    expect(spawned?.args[0]).toBe('-p');
    expect(spawned?.args[1]).toBe('--model');
    expect(spawned?.args[2]).toBe('zai/glm-5.3:max');
    expect(spawned?.args[3]).toContain('kimi');
    expect(spawned?.args[3]).toContain(FIXABLE_ERROR);
    expect(spawned?.args[3]).not.toContain('brave');
    expect(spawned?.opts.cwd).toBe(process.cwd());
    expect(spawned?.opts.logFile).toBe('data/watchdog/run-1.log');

    const [run] = store.getRunningWatchdogRuns();

    expect(run?.providers).toEqual(['kimi']);
    expect(run?.pid).toBe(FAKE_PID);
    expect(run?.day).toBe(localDay(NOW));
  });

  it('does not launch twice while a run is still running', () => {
    const { watchdog, store, spawns } = makeWatchdog(mixedStaleManager());

    watchdog.tick(NOW);
    // Simulate the spawned agent still being alive within the run timeout.
    store.setWatchdogRunPid(1, process.pid);

    // 30 minutes later: run is neither timed out nor dead, so no new launch.
    watchdog.tick(NOW + HALF_GAP_MS);

    expect(spawns).toHaveLength(1);
  });

  it('blocks the launch while the min gap since the last run has not passed', () => {
    const metrics = [metric('kimi', 'Kimi', { lastSuccessAt: NOW - STALE_MS - MS_PER_HOUR })];
    const { watchdog, store, spawns } = makeWatchdog(
      makeManager(metrics, [errorLog('kimi', FIXABLE_ERROR)]),
    );

    store.addWatchdogRun(localDay(NOW), NOW - HALF_GAP_MS, ['kimi'], DEAD_PID);
    store.finishWatchdogRun(1, 'finished', NOW);

    watchdog.tick(NOW);

    expect(spawns).toHaveLength(0);
  });

  it('blocks the third launch of the same local day', () => {
    const metrics = [metric('kimi', 'Kimi', { lastSuccessAt: NOW - STALE_MS - MS_PER_HOUR })];
    const { watchdog, store, spawns } = makeWatchdog(
      makeManager(metrics, [errorLog('kimi', FIXABLE_ERROR)]),
    );
    const day = localDay(NOW);

    store.addWatchdogRun(day, NOW - THREE_TIMES * GAP_OK_MS, ['kimi'], DEAD_PID);
    store.addWatchdogRun(day, NOW - TWICE * GAP_OK_MS, ['kimi'], DEAD_PID);

    watchdog.tick(NOW);

    expect(spawns).toHaveLength(0);
    expect(store.countWatchdogRunsForDay(day)).toBe(TWICE);
  });
});

// ── tick: reaping ───────────────────────────────────────────

describe('Watchdog.tick — reap', () => {
  it('marks a run with a dead pid as finished', () => {
    const metrics = [metric('zai', 'Zai', { lastSuccessAt: NOW })];
    const { watchdog, store } = makeWatchdog(makeManager(metrics, []));

    store.addWatchdogRun(localDay(NOW), NOW - FIVE_MIN * MS_PER_MINUTE, ['kimi'], DEAD_PID);

    watchdog.tick(NOW);

    expect(store.runs[0]?.status).toBe('finished');
    expect(store.runs[0]?.finishedAt).toBe(NOW);
  });

  it('marks an over-timeout run as timeout even when the pid looks alive', () => {
    const metrics = [metric('zai', 'Zai', { lastSuccessAt: NOW })];
    const { watchdog, store } = makeWatchdog(makeManager(metrics, []));

    store.addWatchdogRun(localDay(NOW), NOW - GAP_OK_MS, ['kimi'], process.pid);

    watchdog.tick(NOW);

    expect(store.runs[0]?.status).toBe('timeout');
  });

  it('keeps a recent run with a live pid running', () => {
    const metrics = [metric('zai', 'Zai', { lastSuccessAt: NOW })];
    const { watchdog, store } = makeWatchdog(makeManager(metrics, []));

    store.addWatchdogRun(localDay(NOW), NOW - FIVE_MIN * MS_PER_MINUTE, ['kimi'], process.pid);

    watchdog.tick(NOW);

    expect(store.runs[0]?.status).toBe('running');
  });
});

// ── tick: escalation ────────────────────────────────────────

describe('Watchdog.tick — escalation', () => {
  it('opens exactly one repair-failed alert when the daily budget is spent', () => {
    const metrics = [metric('kimi', 'Kimi', { lastSuccessAt: NOW - STALE_MS - MS_PER_HOUR })];
    const { watchdog, store, spawns } = makeWatchdog(
      makeManager(metrics, [errorLog('kimi', FIXABLE_ERROR)]),
    );
    const day = localDay(NOW);

    store.addWatchdogRun(day, NOW - THREE_TIMES * GAP_OK_MS, ['kimi'], DEAD_PID);
    store.addWatchdogRun(day, NOW - TWICE * GAP_OK_MS, ['kimi'], DEAD_PID);

    watchdog.tick(NOW);
    watchdog.tick(NOW + MS_PER_MINUTE);

    const failed = store.alerts.filter((a) => a.kind === 'repair-failed');

    expect(failed).toHaveLength(1);
    expect(failed[0]?.providerId).toBeNull();
    expect(failed[0]?.message).toBe(
      `Auto-repair ran ${config.WATCHDOG_MAX_RUNS_PER_DAY} times today, still failing: kimi`,
    );
    expect(spawns).toHaveLength(0);
  });

  it('does not escalate while a run is still running', () => {
    const metrics = [metric('kimi', 'Kimi', { lastSuccessAt: NOW - STALE_MS - MS_PER_HOUR })];
    const { watchdog, store } = makeWatchdog(
      makeManager(metrics, [errorLog('kimi', FIXABLE_ERROR)]),
    );
    const day = localDay(NOW);

    store.addWatchdogRun(day, NOW - THREE_TIMES * GAP_OK_MS, ['kimi'], DEAD_PID);
    store.addWatchdogRun(day, NOW - MS_PER_MINUTE, ['kimi'], process.pid);

    watchdog.tick(NOW);

    expect(store.alerts.filter((a) => a.kind === 'repair-failed')).toHaveLength(0);
  });
});

// ── getPanelData ────────────────────────────────────────────

describe('Watchdog.getPanelData', () => {
  it('returns today budget, recent runs, problems and open alerts', () => {
    const { watchdog, store } = makeWatchdog(mixedStaleManager());

    store.addWatchdogRun(localDay(NOW), NOW - MS_PER_MINUTE, ['kimi'], FAKE_PID);

    watchdog.tick(NOW);

    const data = watchdog.getPanelData();

    expect(data.enabled).toBe(true);
    expect(data.today.day).toBe(localDay(NOW));
    expect(data.today.max).toBe(config.WATCHDOG_MAX_RUNS_PER_DAY);
    expect(data.today.runs).toBeGreaterThanOrEqual(1);

    expect(data.problems.map((p) => p.providerId).sort()).toEqual(['brave', 'kimi']);
    expect(data.problems.find((p) => p.providerId === 'brave')?.needsHuman).toBe(true);
    expect(data.problems.find((p) => p.providerId === 'kimi')?.needsHuman).toBe(false);

    expect(data.runs.length).toBeLessThanOrEqual(RECENT_LIMIT);
    expect(data.runs[0]?.providers).toEqual(['kimi']);
    expect(data.alerts.map((a) => a.kind)).toContain('login-required');
  });
});
