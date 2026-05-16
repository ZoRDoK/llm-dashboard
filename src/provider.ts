import { ModelUsage } from './model-usage.js';
import type { UsageWindow } from './usage-window.js';

export class Provider {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly plan: string,
    readonly models: ModelUsage[],
    readonly error?: string,
  ) {}

  static fromAdapter(
    id: string,
    name: string,
    plan: string,
    windows: UsageWindow[],
    modelName?: string,
  ): Provider {
    return new Provider(id, name, plan, [ModelUsage.from(modelName ?? plan, windows)]);
  }
}
