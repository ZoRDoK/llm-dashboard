import { describe, expect, it } from 'vitest';
import { MS_PER_HOUR, MS_PER_MINUTE } from '../../src/constants.js';
import { renderWatchdogPanel } from '../../src/html/watchdog-panel.js';
import type { WatchdogPanelData, WatchdogProblem } from '../../src/watchdog.js';

// ── Constants ───────────────────────────────────────────────

const NOW = 1_780_000_000_000;
const MAX_RUNS = 2;
const RUNS_TODAY = 2;
const THREE_POINT_TWO = 3.2;
const TEN_MINUTES = 10;
const RUN_LINE_COUNT = 4;
const LAST_SHOWN_RUN = 4;
const FIRST_HIDDEN_RUN = 1;
const SECOND_RUN = 2;
const THIRD_RUN = 3;
const LAG_3H_MS = THREE_POINT_TWO * MS_PER_HOUR;
const LAG_10M_MS = TEN_MINUTES * MS_PER_MINUTE;
const LONG_ERROR_LENGTH = 200;
const TRUNCATE_AT = 90;

// ── Fixtures ────────────────────────────────────────────────

function problem(overrides: Partial<WatchdogProblem> = {}): WatchdogProblem {
  return {
    providerId: 'kimi',
    name: 'Kimi',
    lagMs: LAG_3H_MS,
    error: 'kimi update failed: HTTP 500',
    needsHuman: false,
    ...overrides,
  };
}

function panelData(overrides: Partial<WatchdogPanelData> = {}): WatchdogPanelData {
  return {
    enabled: true,
    today: { day: '2026-06-15', runs: RUNS_TODAY, max: MAX_RUNS },
    runs: [
      { startedAt: NOW, finishedAt: NOW + LAG_10M_MS, status: 'finished', providers: ['kimi'] },
    ],
    problems: [problem()],
    alerts: [],
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('renderWatchdogPanel', () => {
  it('renders the header badge with today run counts', () => {
    const html = renderWatchdogPanel(panelData());

    expect(html).toContain('Watchdog');
    expect(html).toContain('2/2 runs today');
  });

  it('renders a fixable problem line with warning icon, lag and error', () => {
    const html = renderWatchdogPanel(panelData());

    expect(html).toContain('⚠️');
    expect(html).toContain('Kimi');
    expect(html).toContain('3.2h behind');
    expect(html).toContain('kimi update failed: HTTP 500');
    expect(html).not.toContain('🔑');
  });

  it('renders a needs-human problem line with key icon', () => {
    const html = renderWatchdogPanel(
      panelData({ problems: [problem({ needsHuman: true, name: 'Brave' })] }),
    );

    expect(html).toContain('🔑');
    expect(html).toContain('Brave');
  });

  it('escapes html in error messages', () => {
    const html = renderWatchdogPanel(
      panelData({ problems: [problem({ error: 'boom <script>alert(1)</script>' })] }),
    );

    expect(html).toContain('boom &lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('truncates long error messages', () => {
    const longError = 'x'.repeat(LONG_ERROR_LENGTH);
    const html = renderWatchdogPanel(panelData({ problems: [problem({ error: longError })] }));

    expect(html).toContain('…');

    const shown = longError.slice(0, TRUNCATE_AT);

    expect(html).toContain(shown);
    expect(html).not.toContain(longError);
  });

  it('renders the exhausted line when a repair-failed alert is open', () => {
    const html = renderWatchdogPanel(
      panelData({
        alerts: [
          {
            id: 1,
            providerId: null,
            kind: 'repair-failed',
            message: 'Auto-repair ran 2 times today, still failing: kimi',
            createdAt: NOW,
            resolvedAt: null,
          },
        ],
      }),
    );

    expect(html).toContain('Auto-repair exhausted today (2/2)');
    expect(html).toContain('still failing: kimi');
  });

  it('falls back to the alert message when no fixable problems remain', () => {
    const message = 'Auto-repair ran 2 times today, still failing: kimi';
    const html = renderWatchdogPanel(
      panelData({
        problems: [],
        alerts: [
          {
            id: 1,
            providerId: null,
            kind: 'repair-failed',
            message,
            createdAt: NOW,
            resolvedAt: null,
          },
        ],
      }),
    );

    expect(html).toContain(message);
  });

  it('shows the empty state for problems', () => {
    const html = renderWatchdogPanel(panelData({ problems: [] }));

    expect(html).toContain('All providers fresh');
  });

  it('shows the empty state for runs', () => {
    const html = renderWatchdogPanel(panelData({ runs: [] }));

    expect(html).toContain('No runs yet');
  });

  it('renders run lines with time, provider ids and status', () => {
    const html = renderWatchdogPanel(panelData());

    expect(html).toContain('kimi');
    expect(html).toContain('finished');
  });

  it('shows at most three run lines (runs arrive newest-first)', () => {
    // Same order as getRecentWatchdogRuns: newest first.
    const runs = [LAST_SHOWN_RUN, THIRD_RUN, SECOND_RUN, FIRST_HIDDEN_RUN].map((n) => ({
      startedAt: NOW + n * MS_PER_MINUTE,
      finishedAt: null,
      status: 'running',
      providers: [`p${n}`],
    }));
    const html = renderWatchdogPanel(panelData({ runs }));

    expect(html).toContain(`p${SECOND_RUN}`);
    expect(html).toContain(`p${THIRD_RUN}`);
    expect(html).toContain(`p${LAST_SHOWN_RUN}`);
    expect(html).not.toContain(`p${FIRST_HIDDEN_RUN}`);
    expect(runs).toHaveLength(RUN_LINE_COUNT);
  });
});
