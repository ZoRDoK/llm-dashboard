import { describe, expect, it } from 'vitest';
import { LogStore } from '../../src/log-store.js';
import type { LogEntry } from '../../src/types.js';

// ── Constants ───────────────────────────────────────────────

const LOG_CAP = 500;
const DEFAULT_LIMIT = 200;
const THREE = 3;
const EXTRA = 2;
const OVER_LIMIT = 250;

const BASE_TS = 1_700_000_000_000;
const TS_STEP = 1_000;

function makeEntry(index: number, message?: string): LogEntry {
  return {
    ts: BASE_TS + index * TS_STEP,
    level: 'info',
    message: message ?? `event-${index}`,
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('LogStore', () => {
  describe('push / recent', () => {
    it('returns empty array when no entries pushed', () => {
      const store = new LogStore();

      expect(store.recent()).toEqual([]);
    });

    it('returns entries newest-first after pushing', () => {
      const store = new LogStore();

      store.push(makeEntry(0, 'first'));
      store.push(makeEntry(1, 'second'));
      store.push(makeEntry(2, 'third'));

      const result = store.recent();

      expect(result).toHaveLength(THREE);
      expect(result[0].message).toBe('third');
      expect(result[1].message).toBe('second');
      expect(result[2].message).toBe('first');
      expect(result[0].ts).toBeGreaterThan(result[1].ts);
    });

    it('recent(limit) returns at most limit entries', () => {
      const store = new LogStore();

      for (let i = 0; i < 10; i++) {
        store.push(makeEntry(i));
      }

      const result = store.recent(THREE);

      expect(result).toHaveLength(THREE);
    });

    it('recent with default limit returns at most DEFAULT_LIMIT entries', () => {
      const store = new LogStore();

      for (let i = 0; i < OVER_LIMIT; i++) {
        store.push(makeEntry(i));
      }

      const result = store.recent();

      expect(result.length).toBeLessThanOrEqual(DEFAULT_LIMIT);
      expect(result.length).toBe(DEFAULT_LIMIT);
    });
  });

  describe('capacity', () => {
    it('trims to LOG_CAP entries when pushing beyond capacity', () => {
      const store = new LogStore();

      for (let i = 0; i < LOG_CAP + EXTRA; i++) {
        store.push(makeEntry(i));
      }

      const result = store.recent(LOG_CAP + EXTRA);

      expect(result).toHaveLength(LOG_CAP);
    });

    it('keeps the newest entries when trimming', () => {
      const store = new LogStore();

      for (let i = 0; i < LOG_CAP + EXTRA; i++) {
        store.push(makeEntry(i));
      }

      const result = store.recent(LOG_CAP + EXTRA);

      // After truncation, newest is first, oldest is last.
      // The trimmed entries were the first two pushed (indices 0, 1).
      // After 502 pushes, entries 2..501 remain.
      // Newest (501) is at index 0, oldest (2) is at index 499.
      expect(result[0].message).toBe(`event-${LOG_CAP + EXTRA - 1}`);

      const oldestMsg = result[result.length - 1].message;

      expect(oldestMsg).toBe(`event-${EXTRA}`);
    });

    it('does not trim when exactly at capacity', () => {
      const store = new LogStore();

      for (let i = 0; i < LOG_CAP; i++) {
        store.push(makeEntry(i));
      }

      const result = store.recent(LOG_CAP + EXTRA);

      expect(result).toHaveLength(LOG_CAP);
      expect(result[0].message).toBe(`event-${LOG_CAP - 1}`);
      expect(result[result.length - 1].message).toBe('event-0');
    });
  });
});
