import type { ModelUsage } from './model-usage.js';
import type { UsageWindow } from './usage-window.js';

export class Provider {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly plan: string,
    readonly models: ModelUsage[],
    readonly error?: string,
    readonly updatedAt?: number,
    readonly stale?: boolean,
  ) {}

  static fromAdapter(
    id: string,
    name: string,
    plan: string,
    windows: UsageWindow[],
    modelName?: string,
  ): Provider {
    return new Provider(id, name, plan, [{ modelName: modelName ?? plan, windows }]);
  }

  /** Placeholder returned by adapters whose credentials are missing. */
  static notConfigured(id: string, name: string, error?: string): Provider {
    return new Provider(id, name, 'Not configured', [], error);
  }
}
