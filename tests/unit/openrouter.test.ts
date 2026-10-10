import { describe, expect, it } from 'vitest';
import { buildOpenRouterWindows } from '../../src/adapters/openrouter.js';

const TOTAL_CREDITS = 23;
const TOTAL_USAGE = 17.4417;
const PERCENT_FULL = 100;
const EDGE_CREDITS = 10;
const EDGE_USAGE = 99;

describe('buildOpenRouterWindows', () => {
  it('builds one credits window with a remaining valueLabel and percent in 0..100', () => {
    const windows = buildOpenRouterWindows(TOTAL_CREDITS, TOTAL_USAGE);
    const win = windows[0];

    expect(windows).toHaveLength(1);
    expect(win.label).toBe('credits');
    expect(win.valueLabel).toContain('$5.56 of $23.00');
    expect(win.used).toBe(TOTAL_USAGE);
    expect(win.total).toBe(TOTAL_CREDITS);
    expect(win.usedPercent).toBeGreaterThanOrEqual(0);
    expect(win.usedPercent).toBeLessThanOrEqual(PERCENT_FULL);
  });

  it('clamps usage that exceeds credits so used never exceeds total (no throw)', () => {
    const windows = buildOpenRouterWindows(EDGE_CREDITS, EDGE_USAGE);
    const win = windows[0];

    expect(win.used).toBe(EDGE_CREDITS);
    expect(win.total).toBe(EDGE_CREDITS);
    expect(win.usedPercent).toBe(PERCENT_FULL);
  });
});
