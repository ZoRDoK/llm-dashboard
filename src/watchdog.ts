/**
 * Self-healing watchdog.
 *
 * Periodically checks provider freshness from the manager metrics. When a
 * provider lags beyond the stale threshold for a fixable reason (code error,
 * scraping breakage), a headless pi agent is spawned to repair it — capped at
 * WATCHDOG_MAX_RUNS_PER_DAY launches per local day. Human-auth problems
 * (expired cookies, logins, missing configuration) never trigger launches;
 * they only raise alerts, because an agent cannot log in for the user.
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import { MS_PER_HOUR, MS_PER_MINUTE } from './constants.js';
import { createLogger } from './logger.js';
import { desktopNotify } from './notify.js';
import type { WatchdogAlertRow, WatchdogRunRow } from './store.js';
import type { LogEntry, ProviderMetrics } from './types.js';

const log = createLogger('watchdog');

// ── Constants ───────────────────────────────────────────────

/** A run older than this is considered hung and reaped as timed out. */
const RUN_TIMEOUT_MS = 60 * MS_PER_MINUTE;

/** Minimum spacing between two agent launches, regardless of outcome. */
const MIN_LAUNCH_GAP_MS = 60 * MS_PER_MINUTE;

const MODEL = 'zai/glm-5.3:max';

/** How many recent runs getPanelData() returns for the dashboard panel. */
const PANEL_RUNS_LIMIT = 5;

const WATCHDOG_LOG_DIR = 'data/watchdog';

/**
 * Error texts that only a human can fix: expired sessions, missing cookies,
 * logins. Matched against the provider's most recent error/warn log message.
 * Verified against real adapter messages such as "Session expired,
 * re-authenticate required", "Brave session expired — update BRAVE_COOKIE",
 * "No __client cookie found — are you logged into the target site?".
 */
const LOGIN_REQUIRED_RE =
  /log ?in|re-authenticat|session expired|update .*cookie|cookie expired|not configured|are you logged into/i;

// ── Types ───────────────────────────────────────────────────

/** Structural slice of ProviderStore that the watchdog depends on. */
export interface WatchdogStoreApi {
  addWatchdogRun(day: string, startedAt: number, providers: string[], pid: number | null): number;
  setWatchdogRunPid(id: number, pid: number): void;
  finishWatchdogRun(id: number, status: string, finishedAt: number): void;
  getRunningWatchdogRuns(): WatchdogRunRow[];
  getRecentWatchdogRuns(limit: number): WatchdogRunRow[];
  countWatchdogRunsForDay(day: string): number;
  openWatchdogAlert(
    kind: string,
    providerId: string | null,
    message: string,
    createdAt: number,
  ): void;
  getOpenWatchdogAlerts(): WatchdogAlertRow[];
  resolveWatchdogAlert(kind: string, providerId: string | null): void;
  resolveAllOpenWatchdogAlerts(): void;
}

/** Structural slice of ProviderManager that the watchdog depends on. */
export interface WatchdogManagerApi {
  getMetrics(): ProviderMetrics[];
  getLogs(): LogEntry[];
}

export interface WatchdogProblem {
  providerId: string;
  name: string;
  lagMs: number;
  error: string | null;
  needsHuman: boolean;
}

interface WatchdogRunSummary {
  startedAt: number;
  finishedAt: number | null;
  status: string;
  providers: string[];
}

export interface WatchdogPanelData {
  enabled: boolean;
  today: { day: string; runs: number; max: number };
  runs: WatchdogRunSummary[];
  problems: WatchdogProblem[];
  alerts: WatchdogAlertRow[];
}

export interface SpawnOptions {
  cwd: string;
  logFile: string;
}

interface SpawnResult {
  pid: number;
}

/** Desktop notification text: the alert title and the one-line reason. */
type DesktopNotify = (title: string, body: string) => void;

interface WatchdogDeps {
  store: WatchdogStoreApi;
  manager: WatchdogManagerApi;
  spawnCmd?: (command: string, args: string[], opts: SpawnOptions) => SpawnResult;
  notify?: DesktopNotify;
  now?: () => number;
}

// ── Pure helpers (exported for tests) ───────────────────────

/** True when the error text means a human must re-authenticate or configure. */
export function classifyNeedsHuman(error: string | null | undefined): boolean {
  if (!error) {
    return false;
  }

  return LOGIN_REQUIRED_RE.test(error);
}

/** Stale means strictly beyond the threshold, not exactly at it. */
export function isStale(lagMs: number, thresholdMs: number): boolean {
  return lagMs > thresholdMs;
}

/** Local day key (YYYY-MM-DD); 'sv' locale formats ISO-like without timezone. */
export function localDay(now: number): string {
  return new Date(now).toLocaleDateString('sv');
}

/** Human-readable lag label for the panel, e.g. "3.2h behind". */
export function formatLag(lagMs: number): string {
  const hours = lagMs / MS_PER_HOUR;

  if (hours < 1) {
    return `${Math.round(lagMs / MS_PER_MINUTE)}m behind`;
  }

  if (hours < 24) {
    return `${hours.toFixed(1)}h behind`;
  }

  return `${Math.floor(hours / 24)}d behind`;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Newest warn/error log line for a provider, or null when none exists. */
function lastErrorMessage(logs: LogEntry[], providerId: string): string | null {
  for (const log of logs) {
    if (log.providerId === providerId && (log.level === 'error' || log.level === 'warn')) {
      return log.message;
    }
  }

  return null;
}

/** Newest log line for a provider at any level, or null when none exists. */
function latestLogMessage(logs: LogEntry[], providerId: string): string | null {
  for (const log of logs) {
    if (log.providerId === providerId) {
      return log.message;
    }
  }

  return null;
}

/**
 * Auth/config failures the staleness scan cannot see: brave keeps retrying
 * every minute (lag ≈ 0) and context7 is not configured at all, so neither
 * ever looks stale. Any not-yet-flagged provider whose newest log line at any
 * level needs a human becomes a problem; an agent can never fix it.
 */
function authProblems(
  metrics: ProviderMetrics[],
  logs: LogEntry[],
  now: number,
  known: WatchdogProblem[],
): WatchdogProblem[] {
  const flagged = new Set(known.map((p) => p.providerId));
  const problems: WatchdogProblem[] = [];

  for (const m of metrics) {
    if (flagged.has(m.id)) {
      continue;
    }

    const message = latestLogMessage(logs, m.id);

    if (!classifyNeedsHuman(message)) {
      continue;
    }

    problems.push({
      providerId: m.id,
      name: m.name,
      lagMs: now - (m.lastSuccessAt ?? m.lastAttemptAt ?? now),
      error: message,
      needsHuman: true,
    });
  }

  return problems;
}

/** Compose the English repair prompt for the headless agent. */
function buildPrompt(problems: WatchdogProblem[]): string {
  const lines = problems.map(
    (p) => `- ${p.name} (${p.providerId}): ${formatLag(p.lagMs)}, last error: ${p.error ?? 'none'}`,
  );

  return [
    'Self-healing task for the ai-creds provider dashboard.',
    '',
    'The following providers are stale (no successful refresh beyond the stale threshold):',
    ...lines,
    '',
    'Context:',
    '- Working directory: /home/slava/dev/projects/ai-creds',
    '- The service runs compiled dist on http://127.0.0.1:3102 as systemd --user unit ai-creds.service',
    '',
    'Required flow:',
    '1. Diagnose: probe the live adapter code and read logs with journalctl --user -u ai-creds.service.',
    '2. Fix the code.',
    '3. npm run check must pass with 0 errors.',
    '4. npm test must pass.',
    '5. npm run build.',
    '6. systemctl --user restart ai-creds.service.',
    '7. Verify via curl -s http://127.0.0.1:3102/api/providers that the listed providers have fresh updatedAt and no error.',
    '',
    'Rules:',
    '- Apply /home/slava/.pi/agent/skills/style/SKILL.md.',
    '- Biome strict; English only.',
    '- No commits.',
    '- Do not touch data/ files.',
    '- Do not modify src/watchdog.ts or the watchdog SQLite tables.',
  ].join('\n');
}

/**
 * Default spawner: detach the agent, redirect its output to the run log file,
 * and let it outlive this server process.
 */
function defaultSpawnCmd(command: string, args: string[], opts: SpawnOptions): SpawnResult {
  mkdirSync(dirname(opts.logFile), { recursive: true });

  const fd = openSync(opts.logFile, 'a');
  const child = spawn(command, args, {
    cwd: opts.cwd,
    detached: true,
    stdio: ['ignore', fd, fd],
  });

  child.unref();
  // The child holds dup'd descriptors; close the parent-side copy.
  closeSync(fd);

  return { pid: child.pid ?? -1 };
}

// ── Watchdog ────────────────────────────────────────────────

export class Watchdog {
  private readonly store: WatchdogStoreApi;
  private readonly manager: WatchdogManagerApi;
  private readonly spawnCmd: (command: string, args: string[], opts: SpawnOptions) => SpawnResult;
  private readonly notify: DesktopNotify;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: WatchdogDeps) {
    this.store = deps.store;
    this.manager = deps.manager;
    this.spawnCmd = deps.spawnCmd ?? defaultSpawnCmd;
    this.notify = deps.notify ?? desktopNotify;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => this.tick(), config.WATCHDOG_TICK_MINUTES * MS_PER_MINUTE);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One full watchdog cycle: reap, detect, alert, maybe launch, maybe escalate. */
  tick(nowMs?: number): void {
    const now = nowMs ?? this.now();

    this.reap(now);

    const problems = this.collectProblems(now);

    this.maintainAlerts(problems, now);

    if (!config.WATCHDOG_ENABLED) {
      return;
    }

    this.maybeLaunch(problems, now);
    this.maybeEscalate(problems, now);
  }

  /** Close out running runs that are hung (old) or whose process is gone. */
  private reap(now: number): void {
    const running = this.store.getRunningWatchdogRuns();

    for (const run of running) {
      if (now - run.startedAt > RUN_TIMEOUT_MS) {
        this.store.finishWatchdogRun(run.id, 'timeout', now);
        log.warn({ runId: run.id, startedAt: run.startedAt }, 'Watchdog run reaped as timeout');
        continue;
      }

      if (run.pid != null && !isPidAlive(run.pid)) {
        this.store.finishWatchdogRun(run.id, 'finished', now);
        log.debug({ runId: run.id, pid: run.pid }, 'Watchdog run finished: process exited');
      }
    }
  }

  /**
   * Detect stale providers and auth failures, enriching each with its last
   * error.
   */
  private collectProblems(now: number): WatchdogProblem[] {
    const metrics = this.manager.getMetrics().filter((m) => !m.archived);
    const logs = this.manager.getLogs();
    const thresholdMs = config.WATCHDOG_STALE_HOURS * MS_PER_HOUR;
    const problems: WatchdogProblem[] = [];

    for (const m of metrics) {
      if (!m.configured) {
        continue;
      }

      // Providers that never ran have no lag; they cannot be stale yet.
      const lagMs = now - (m.lastSuccessAt ?? m.lastAttemptAt ?? now);

      if (!isStale(lagMs, thresholdMs)) {
        continue;
      }

      // alibaba-qwen serves stale data without an error on the Provider object,
      // so the log store is the source of truth for the error text.
      const error = lastErrorMessage(logs, m.id);

      problems.push({
        providerId: m.id,
        name: m.name,
        lagMs,
        error,
        needsHuman: classifyNeedsHuman(error),
      });
    }

    return [...problems, ...authProblems(metrics, logs, now, problems)];
  }

  /** Keep login-required alerts in sync with the current stale set. */
  private maintainAlerts(problems: WatchdogProblem[], now: number): void {
    if (problems.length === 0) {
      this.resolveAllAlerts();

      return;
    }

    const openAlerts = this.store.getOpenWatchdogAlerts();
    const staleIds = new Set(problems.map((p) => p.providerId));
    const hasOpenLoginAlert = (providerId: string) =>
      openAlerts.some((a) => a.kind === 'login-required' && a.providerId === providerId);

    for (const p of problems) {
      if (!p.needsHuman || hasOpenLoginAlert(p.providerId)) {
        continue;
      }

      this.store.openWatchdogAlert(
        'login-required',
        p.providerId,
        `${p.name}: login required (${p.error ?? 'no error recorded'})`,
        now,
      );

      log.warn({ providerId: p.providerId, reason: p.error }, 'Watchdog login alert opened');

      // Out-of-band signal on the open edge only — the dashboard alert alone
      // went unnoticed for days. The hasOpenLoginAlert gate above makes this
      // fire exactly once per alert.
      this.notify('AI Creds: login required', `${p.name}: ${p.error}`);
    }

    for (const alert of openAlerts) {
      if (alert.kind !== 'login-required' || alert.providerId == null) {
        continue;
      }

      if (!staleIds.has(alert.providerId)) {
        this.store.resolveWatchdogAlert('login-required', alert.providerId);
        log.info({ providerId: alert.providerId }, 'Watchdog login alert resolved');
      }
    }
  }

  /** Resolve every open alert, logging only when there was something to resolve. */
  private resolveAllAlerts(): void {
    const open = this.store.getOpenWatchdogAlerts();

    if (open.length === 0) {
      return;
    }

    this.store.resolveAllOpenWatchdogAlerts();
    log.info({ count: open.length }, 'Watchdog alerts resolved');
  }

  /** Shared launch/escalation preconditions: fixable staleness, no run in flight. */
  private repairContext(
    problems: WatchdogProblem[],
    now: number,
  ): { fixable: WatchdogProblem[]; day: string; runsToday: number } | null {
    const fixable = problems.filter((p) => !p.needsHuman);

    if (fixable.length === 0) {
      return null;
    }

    if (this.store.getRunningWatchdogRuns().length > 0) {
      return null;
    }

    const day = localDay(now);

    return { fixable, day, runsToday: this.store.countWatchdogRunsForDay(day) };
  }

  /** Launch an agent when there is fixable staleness and budget to fix it. */
  private maybeLaunch(problems: WatchdogProblem[], now: number): void {
    const context = this.repairContext(problems, now);

    if (!context) {
      return;
    }

    if (context.runsToday >= config.WATCHDOG_MAX_RUNS_PER_DAY) {
      log.debug(
        { runsToday: context.runsToday, max: config.WATCHDOG_MAX_RUNS_PER_DAY },
        'Watchdog launch skipped: daily budget spent',
      );

      return;
    }

    const [lastRun] = this.store.getRecentWatchdogRuns(1);

    if (lastRun && now - lastRun.startedAt < MIN_LAUNCH_GAP_MS) {
      log.debug(
        { sinceLastRunMs: now - lastRun.startedAt },
        'Watchdog launch skipped: minimum gap not elapsed',
      );

      return;
    }

    this.launch(context.fixable, now, context.day);
  }

  private launch(problems: WatchdogProblem[], now: number, day: string): void {
    const providerIds = problems.map((p) => p.providerId);

    // Insert first so the run id can name the log file, then record the pid.
    const runId = this.store.addWatchdogRun(day, now, providerIds, null);

    const spawnOptions: SpawnOptions = {
      cwd: process.cwd(),
      logFile: `${WATCHDOG_LOG_DIR}/run-${runId}.log`,
    };

    const child = this.spawnCmd(
      config.WATCHDOG_PI_PATH,
      ['-p', '--model', MODEL, buildPrompt(problems)],
      spawnOptions,
    );

    this.store.setWatchdogRunPid(runId, child.pid);

    log.info({ runId, providers: providerIds }, 'Watchdog launched auto-repair run');
  }

  /** Open a persistent repair-failed alert once the daily budget is spent. */
  private maybeEscalate(problems: WatchdogProblem[], now: number): void {
    const context = this.repairContext(problems, now);

    if (!context || context.runsToday < config.WATCHDOG_MAX_RUNS_PER_DAY) {
      return;
    }

    const openAlerts = this.store.getOpenWatchdogAlerts();

    if (openAlerts.some((a) => a.kind === 'repair-failed')) {
      return;
    }

    const ids = context.fixable.map((p) => p.providerId).join(', ');

    this.store.openWatchdogAlert(
      'repair-failed',
      null,
      `Auto-repair ran ${context.runsToday} times today, still failing: ${ids}`,
      now,
    );

    log.warn(
      { runsToday: context.runsToday, providers: context.fixable.map((p) => p.providerId) },
      'Watchdog repair-failed alert opened',
    );
  }

  getPanelData(): WatchdogPanelData {
    const now = this.now();
    const problems = this.collectProblems(now);
    const day = localDay(now);
    const runs = this.store.getRecentWatchdogRuns(PANEL_RUNS_LIMIT).map((r) => ({
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      status: r.status,
      providers: r.providers,
    }));

    return {
      enabled: config.WATCHDOG_ENABLED,
      today: {
        day,
        runs: this.store.countWatchdogRunsForDay(day),
        max: config.WATCHDOG_MAX_RUNS_PER_DAY,
      },
      runs,
      problems,
      alerts: this.store.getOpenWatchdogAlerts(),
    };
  }
}
