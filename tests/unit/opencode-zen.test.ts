import { describe, expect, it } from 'vitest';
import { zenBalanceFromStatus } from '../../src/adapters/opencode-zen.js';

// Live `/billing/status` sample (2026-09-22): 999525891 microcents = $9.99525891.
const STATUS_SAMPLE = {
  billingMode: 'prepaid',
  mode: 'pay-as-you-go',
  balanceMicroCents: '999525891',
  creditLimitMicroCents: null,
  availableMicroCents: '999525891',
  canPurchaseCredits: true,
  canEnableAutoRecharge: true,
  canEnrollInPrepaid: false,
};

const BALANCE_DOLLARS = 9.99525891;

describe('zenBalanceFromStatus', () => {
  it('converts the microcent balance string to dollars', () => {
    expect(zenBalanceFromStatus(STATUS_SAMPLE)).toBe(BALANCE_DOLLARS);
  });

  it('throws when the balance field is missing', () => {
    expect(() => zenBalanceFromStatus({ billingMode: 'prepaid' })).toThrow();
  });

  it('throws when the balance is not a number', () => {
    expect(() => zenBalanceFromStatus({ balanceMicroCents: 'not-a-number' })).toThrow(
      'not a finite number',
    );
  });

  it('throws when the balance is not finite', () => {
    expect(() => zenBalanceFromStatus({ balanceMicroCents: 'Infinity' })).toThrow(
      'not a finite number',
    );
  });
});
