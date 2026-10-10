import { describe, expect, it } from 'vitest';
import { Provider } from '../../src/provider.js';
import { UsageWindow } from '../../src/usage-window.js';

const USED_PERCENT = 50;
const TIMESTAMP = 1234;

describe('Provider', () => {
  it('exposes the fields passed to the constructor', () => {
    const window = UsageWindow.fromApi('daily', USED_PERCENT, null);
    const model = { modelName: 'gpt', windows: [window] };
    const provider = new Provider('openai', 'OpenAI', 'pro', [model]);

    expect(provider.id).toBe('openai');
    expect(provider.name).toBe('OpenAI');
    expect(provider.plan).toBe('pro');
    expect(provider.models).toEqual([model]);
    expect(provider.error).toBeUndefined();
    expect(provider.updatedAt).toBeUndefined();
    expect(provider.stale).toBeUndefined();
  });

  it('carries error, updatedAt, and stale when provided', () => {
    const provider = new Provider('x', 'X', 'unknown', [], 'boom', TIMESTAMP, true);

    expect(provider.error).toBe('boom');
    expect(provider.updatedAt).toBe(TIMESTAMP);
    expect(provider.stale).toBe(true);
  });
});

describe('Provider.fromAdapter', () => {
  it('wraps windows into a single ModelUsage named after the plan by default', () => {
    const window = UsageWindow.fromApi('daily', USED_PERCENT, null);
    const provider = Provider.fromAdapter('id', 'Name', 'pro', [window]);

    expect(provider.id).toBe('id');
    expect(provider.name).toBe('Name');
    expect(provider.plan).toBe('pro');
    expect(provider.models).toHaveLength(1);
    expect(provider.models[0].modelName).toBe('pro');
    expect(provider.models[0].windows).toEqual([window]);
  });

  it('uses the provided modelName when given', () => {
    const window = UsageWindow.fromApi('daily', USED_PERCENT, null);
    const provider = Provider.fromAdapter('id', 'Name', 'pro', [window], 'gpt-4');

    expect(provider.models[0].modelName).toBe('gpt-4');
  });
});
