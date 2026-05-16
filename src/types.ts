import type { Provider } from './provider.js';

export interface ProviderAdapter {
  id: string;
  name: string;
  fetchUsage(): Promise<Provider>;
}
