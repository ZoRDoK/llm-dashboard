import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MS_PER_DAY } from '../../src/constants.js';
import { PiUsageIndex } from '../../src/pi-usage.js';

// ── Constants ───────────────────────────────────────────────

const PROJECT_DIR = '--home-x-proj--';
const PROJECT_LABEL = 'home-x-proj';

const MODEL_CROF = 'crof/glm-5.1-precision';
const MODEL_ZAI = 'zai/glm-5.3';

// File A (20 days old): one counted assistant, one user line, one assistant without usage.
const IN_A = 100;
const OUT_A = 50;
const CR_A = 10;
const CW_A = 5;

// File B (2 days old): two counted assistant calls.
const IN_B1 = 1000;
const OUT_B1 = 200;
const CR_B1 = 4000;
const CW_B1 = 100;
const IN_B2 = 10;
const OUT_B2 = 5;

// File C (10 days old): one counted assistant call.
const IN_C = 500;
const OUT_C = 50;

// File D (1 day old, subagent run-0 child session): one counted assistant call.
const IN_D = 200;
const OUT_D = 100;
const CR_D = 20;
const CW_D = 10;

const FILES_IN_FIXTURE = 4;

// All-time expectations.
const TOTAL_INPUT = IN_A + IN_B1 + IN_B2 + IN_C + IN_D;
const TOTAL_OUTPUT = OUT_A + OUT_B1 + OUT_B2 + OUT_C + OUT_D;
const TOTAL_CACHE_READ = CR_A + CR_B1 + CR_D;
const TOTAL_CACHE_WRITE = CW_A + CW_B1 + CW_D;
const TOTAL_CALLS = 5;
const GRAND_TOTAL = TOTAL_INPUT + TOTAL_OUTPUT + TOTAL_CACHE_READ + TOTAL_CACHE_WRITE;

// Per-model / per-day expectations ('all' range).
const ZAI_TOTAL = 5865;
const ZAI_CALLS = 3;
const CROF_TOTAL = 495;
const DAY_B_TOTAL = 5315;
const BY_DAY_ALL_BUCKETS = 4;
const SHARE_PRECISION = 5;

// Range-7 expectations (files B and D only).
const RANGE7_CALLS = 3;
const RANGE7_SESSIONS = 2;
const RANGE7_DAYS = 2;
const RANGE7_MODELS = 2;
const ZAI_RANGE7_TOTAL = 5315;
const CROF_RANGE7_TOTAL = 330;

// Rewrite / new-session test constants.
const MTIME_BUMP_MS = 5_000;
const IN_B_REWRITTEN = 7;
const IN_NEW_SESSION = 42;

// Fixture day offsets from today.
const DAY_A_OFFSET = 20;
const DAY_B_OFFSET = 2;
const DAY_C_OFFSET = 10;
const DAY_D_OFFSET = 1;
const RANGE7_DAYS_BACK = 7;
const DAYS_FOR_WEEK_TEST = 130;

// ── Helpers ─────────────────────────────────────────────────

const isoDaysAgo = (days: number): string => {
  return new Date(Date.now() - days * MS_PER_DAY).toISOString().slice(0, 10);
};

const usageLine = (
  day: string,
  provider: string,
  model: string,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
): string => {
  return JSON.stringify({
    type: 'message',
    id: 'm',
    timestamp: `${day}T10:05:00.000Z`,
    message: {
      role: 'assistant',
      content: [],
      api: 'openai-completions',
      provider,
      model,
      usage: {
        ...usage,
        totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
      },
    },
  });
};

const sessionLine = (day: string): string => {
  return JSON.stringify({
    type: 'session',
    version: 3,
    id: 's',
    timestamp: `${day}T10:00:00.000Z`,
    cwd: '/home/x/proj',
  });
};

let sessionsDir = '';

function writeSessionFile(relPath: string, lines: string[]): void {
  const absPath = join(sessionsDir, relPath);

  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, `${lines.join('\n')}\n`);
}

/** Populate the shared temp sessions dir with the standard fixture set. */
function seedFixtures(): void {
  const dayA = isoDaysAgo(DAY_A_OFFSET);
  const dayB = isoDaysAgo(DAY_B_OFFSET);
  const dayC = isoDaysAgo(DAY_C_OFFSET);
  const dayD = isoDaysAgo(DAY_D_OFFSET);

  writeSessionFile(`${PROJECT_DIR}/2026-01-02T10-00-00-000Z_a.jsonl`, [
    sessionLine(dayA),
    usageLine(dayA, 'crof', 'glm-5.1-precision', {
      input: IN_A,
      output: OUT_A,
      cacheRead: CR_A,
      cacheWrite: CW_A,
    }),
    JSON.stringify({
      type: 'message',
      id: 'u',
      timestamp: `${dayA}T10:04:00.000Z`,
      message: { role: 'user', content: 'hi' },
    }),
    JSON.stringify({
      type: 'message',
      id: 'n',
      timestamp: `${dayA}T10:06:00.000Z`,
      message: { role: 'assistant', content: [] },
    }),
  ]);

  writeSessionFile(`${PROJECT_DIR}/recent.jsonl`, [
    sessionLine(dayB),
    usageLine(dayB, 'zai', 'glm-5.3', {
      input: IN_B1,
      output: OUT_B1,
      cacheRead: CR_B1,
      cacheWrite: CW_B1,
    }),
    usageLine(dayB, 'zai', 'glm-5.3', {
      input: IN_B2,
      output: OUT_B2,
      cacheRead: 0,
      cacheWrite: 0,
    }),
  ]);

  writeSessionFile(`${PROJECT_DIR}/old.jsonl`, [
    sessionLine(dayC),
    usageLine(dayC, 'zai', 'glm-5.3', { input: IN_C, output: OUT_C, cacheRead: 0, cacheWrite: 0 }),
  ]);

  writeSessionFile(`${PROJECT_DIR}/2026-01-02T11-00-00-000Z_s/child1/run-0/session.jsonl`, [
    sessionLine(dayD),
    usageLine(dayD, 'crof', 'glm-5.1-precision', {
      input: IN_D,
      output: OUT_D,
      cacheRead: CR_D,
      cacheWrite: CW_D,
    }),
  ]);

  // Duplicated transcript format under subagent-artifacts — must be skipped.
  writeSessionFile(`${PROJECT_DIR}/subagent-artifacts/x_transcript.jsonl`, [
    sessionLine(dayA),
    usageLine(dayA, 'crof', 'glm-5.1-precision', {
      input: 999_999,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    }),
  ]);

  // Stale meta files are not session logs.
  writeSessionFile(`${PROJECT_DIR}/2026-01-02T10-00-00-000Z_a.meta.json`, ['{"junk":true}']);
}

function newIndex(): PiUsageIndex {
  return new PiUsageIndex({ dbPath: ':memory:', sessionsDir });
}

// ── Tests ───────────────────────────────────────────────────

beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), 'pi-usage-test-'));

  seedFixtures();
});

afterEach(() => {
  rmSync(sessionsDir, { recursive: true, force: true });
});

describe('PiUsageIndex', () => {
  describe('scan', () => {
    it('indexes assistant usage records and skips artifacts, meta files and non-usage lines', async () => {
      const index = newIndex();

      await index.scan();

      const stats = index.getStats('all');

      expect(stats.totals.input).toBe(TOTAL_INPUT);
      expect(stats.totals.output).toBe(TOTAL_OUTPUT);
      expect(stats.totals.cacheRead).toBe(TOTAL_CACHE_READ);
      expect(stats.totals.cacheWrite).toBe(TOTAL_CACHE_WRITE);
      expect(stats.totals.total).toBe(GRAND_TOTAL);
      expect(stats.totals.calls).toBe(TOTAL_CALLS);
      expect(stats.totals.sessions).toBe(FILES_IN_FIXTURE);
      expect(stats.totals.models).toBe(2);
    });

    it('reports a readable-dir error without throwing when the sessions dir is missing', async () => {
      const index = new PiUsageIndex({
        dbPath: ':memory:',
        sessionsDir: join(sessionsDir, 'nope'),
      });

      await index.scan();

      const status = index.getStatus();

      expect(status.error).toContain('not readable');
      expect(index.getStats('all').totals.calls).toBe(0);
    });
  });

  describe('getStats', () => {
    it('aggregates by model with share and provider rollup, sorted by total desc', async () => {
      const index = newIndex();

      await index.scan();

      const stats = index.getStats('all');

      expect(stats.byModel.map((row) => row.model)).toEqual([MODEL_ZAI, MODEL_CROF]);
      expect(stats.byModel[0]?.total).toBe(ZAI_TOTAL);
      expect(stats.byModel[0]?.calls).toBe(ZAI_CALLS);
      expect(stats.byModel[0]?.share).toBeCloseTo(ZAI_TOTAL / GRAND_TOTAL, SHARE_PRECISION);
      expect(stats.byModel[1]?.total).toBe(CROF_TOTAL);
      expect(stats.byModel[1]?.share).toBeCloseTo(CROF_TOTAL / GRAND_TOTAL, SHARE_PRECISION);

      expect(stats.byProvider.map((row) => row.provider)).toEqual(['zai', 'crof']);
      expect(stats.byProvider[0]?.total).toBe(ZAI_TOTAL);
      expect(stats.byProvider[1]?.calls).toBe(2);
    });

    it('aggregates by day ascending and by project with session counts', async () => {
      const index = newIndex();

      await index.scan();

      const stats = index.getStats('all');

      const days = stats.byDay.map((bucket) => bucket.day);

      expect([...days].sort()).toEqual(days);
      expect(stats.byDay).toHaveLength(BY_DAY_ALL_BUCKETS);
      expect(stats.byDay.find((bucket) => bucket.day === isoDaysAgo(2))?.total).toBe(DAY_B_TOTAL);

      expect(stats.byProject).toHaveLength(1);
      expect(stats.byProject[0]?.project).toBe(PROJECT_LABEL);
      expect(stats.byProject[0]?.total).toBe(GRAND_TOTAL);
      expect(stats.byProject[0]?.sessions).toBe(FILES_IN_FIXTURE);
    });

    it('limits numeric ranges to recent days', async () => {
      const index = newIndex();

      await index.scan();

      const stats = index.getStats(RANGE7_DAYS_BACK);

      expect(stats.totals.calls).toBe(RANGE7_CALLS);
      expect(stats.totals.input).toBe(IN_B1 + IN_B2 + IN_D);
      expect(stats.totals.sessions).toBe(RANGE7_SESSIONS);
      expect(stats.totals.models).toBe(RANGE7_MODELS);
      expect(stats.byDay).toHaveLength(RANGE7_DAYS);
      expect(stats.byModel).toHaveLength(RANGE7_MODELS);
      expect(stats.byModel[0]?.total).toBe(ZAI_RANGE7_TOTAL);
      expect(stats.byModel[0]?.share).toBeCloseTo(
        ZAI_RANGE7_TOTAL / (ZAI_RANGE7_TOTAL + CROF_RANGE7_TOTAL),
        SHARE_PRECISION,
      );
    });

    it('collapses long ranges into ISO-week buckets', async () => {
      const index = new PiUsageIndex({ dbPath: ':memory:', sessionsDir });

      const lines = [sessionLine(isoDaysAgo(DAYS_FOR_WEEK_TEST))];

      for (let i = 0; i < DAYS_FOR_WEEK_TEST; i++) {
        const day = isoDaysAgo(i);

        lines.push(
          usageLine(day, 'zai', 'glm-5.3', { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }),
        );
      }

      writeSessionFile(`${PROJECT_DIR}/many-days.jsonl`, lines);

      await index.scan();

      const stats = index.getStats('all');

      expect(stats.byDay.length).toBeGreaterThan(0);
      expect(stats.byDay.length).toBeLessThan(DAYS_FOR_WEEK_TEST);

      let weekTotal = 0;

      for (const bucket of stats.byDay) {
        const weekday = new Date(`${bucket.day}T00:00:00.000Z`).getUTCDay();

        expect(weekday).toBe(1);
        weekTotal += bucket.total;
      }

      expect(weekTotal).toBe(DAYS_FOR_WEEK_TEST + GRAND_TOTAL);
    });
  });

  describe('incremental scanning', () => {
    it('skips unchanged files on the second scan', async () => {
      const index = newIndex();

      await index.scan();
      await index.scan();

      const status = index.getStatus();

      expect(status.parsed).toBe(0);
      expect(status.scanned).toBe(FILES_IN_FIXTURE);
      expect(status.total).toBe(FILES_IN_FIXTURE);
      expect(status.lastScanAt).not.toBeNull();
    });

    it('re-parses a file when its content changes', async () => {
      const index = newIndex();

      await index.scan();

      const dayB = isoDaysAgo(2);

      writeSessionFile(`${PROJECT_DIR}/recent.jsonl`, [
        sessionLine(dayB),
        usageLine(dayB, 'zai', 'glm-5.3', {
          input: IN_B1,
          output: OUT_B1,
          cacheRead: CR_B1,
          cacheWrite: CW_B1,
        }),
        usageLine(dayB, 'zai', 'glm-5.3', {
          input: IN_B_REWRITTEN,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        }),
      ]);

      // Force a distinctly newer mtime — same-size rewrites could keep mtimeMs ambiguous.
      utimesSync(
        join(sessionsDir, PROJECT_DIR, 'recent.jsonl'),
        new Date(),
        new Date(Date.now() + MTIME_BUMP_MS),
      );

      await index.scan();

      expect(index.getStatus().parsed).toBe(1);
      expect(index.getStats('all').totals.input).toBe(TOTAL_INPUT - IN_B2 + IN_B_REWRITTEN);
    });

    it('drops cache rows for deleted files', async () => {
      const index = newIndex();

      await index.scan();

      rmSync(join(sessionsDir, PROJECT_DIR, 'old.jsonl'));

      await index.scan();

      const stats = index.getStats('all');

      expect(stats.totals.sessions).toBe(FILES_IN_FIXTURE - 1);
      expect(stats.totals.input).toBe(TOTAL_INPUT - IN_C);
      expect(stats.byDay.find((bucket) => bucket.day === isoDaysAgo(10))).toBeUndefined();
    });
  });

  describe('scheduling', () => {
    it('ignores concurrent scans and picks up new files', async () => {
      const index = newIndex();

      await Promise.all([index.scan(), index.scan()]);

      // The second scan hits the running guard, so only one full parse happened.
      expect(index.getStatus().parsed).toBe(FILES_IN_FIXTURE);

      writeSessionFile(`${PROJECT_DIR}/2026-01-02T12-00-00-000Z_new.jsonl`, [
        sessionLine(isoDaysAgo(1)),
        usageLine(isoDaysAgo(1), 'zai', 'glm-5.3', {
          input: IN_NEW_SESSION,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        }),
      ]);

      await index.scan();

      expect(index.getStatus().parsed).toBe(1);
      expect(index.getStats('all').totals.input).toBe(TOTAL_INPUT + IN_NEW_SESSION);
    });
  });
});
