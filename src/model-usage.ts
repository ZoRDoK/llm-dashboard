import type { UsageWindow } from './usage-window.js';

export class ModelUsage {
  private constructor(
    readonly modelName: string,
    readonly windows: UsageWindow[],
  ) {}

  static from(modelName: string, windows: UsageWindow[]): ModelUsage {
    return new ModelUsage(modelName, windows);
  }
}
