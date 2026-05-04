export interface ModelUsage {
  modelName: string;
  fiveHourUsage: number | null;
  fiveHourReset: string | null;
  weeklyUsage: number | null;
  weeklyReset: string | null;
}

export interface Provider {
  id: string;
  name: string;
  plan: string;
  models: ModelUsage[];
  error?: string;
}

export interface ProviderAdapter {
  id: string;
  name: string;
  fetchUsage(): Promise<Provider>;
}
