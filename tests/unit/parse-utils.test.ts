import { describe, expect, it } from 'vitest';
import { parseNumber } from '../../src/parse-utils.js';

// ── Valid number constants ──────────────────────────────────
const ZERO = 0;
const FORTY_TWO = 42;
const NEGATIVE_FIVE = -5;
const PI_APPROX = 3.14;

describe('parseNumber', () => {
  describe('null and undefined', () => {
    it('returns null for null input', () => {
      expect(parseNumber(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(parseNumber(undefined)).toBeNull();
    });
  });

  describe('number input', () => {
    it('returns zero for input 0', () => {
      expect(parseNumber(ZERO)).toBe(ZERO);
    });

    it('returns the number for a positive integer', () => {
      expect(parseNumber(FORTY_TWO)).toBe(FORTY_TWO);
    });

    it('returns the number for a negative integer', () => {
      expect(parseNumber(NEGATIVE_FIVE)).toBe(NEGATIVE_FIVE);
    });

    it('returns the number for a float', () => {
      expect(parseNumber(PI_APPROX)).toBe(PI_APPROX);
    });

    it('returns null for Infinity', () => {
      expect(parseNumber(Number.POSITIVE_INFINITY)).toBeNull();
    });

    it('returns null for NaN', () => {
      expect(parseNumber(Number.NaN)).toBeNull();
    });
  });

  describe('string input', () => {
    it('parses a numeric string to a number', () => {
      expect(parseNumber('42')).toBe(FORTY_TWO);
    });

    it('parses a decimal string to a number', () => {
      expect(parseNumber('3.14')).toBe(PI_APPROX);
    });

    it('parses "0" string to zero', () => {
      expect(parseNumber('0')).toBe(ZERO);
    });

    it('returns null for an empty string', () => {
      expect(parseNumber('')).toBeNull();
    });

    it('returns null for a whitespace-only string', () => {
      expect(parseNumber('  ')).toBeNull();
    });

    it('returns null for a non-numeric string', () => {
      expect(parseNumber('abc')).toBeNull();
    });

    it('returns null for the string "Infinity"', () => {
      expect(parseNumber('Infinity')).toBeNull();
    });
  });
});
