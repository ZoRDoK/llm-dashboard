/**
 * Central provider registry: every adapter the dashboard polls, wired into
 * the manager in one place.
 *
 * Kept side-effect-free (unlike src/index.ts, which boots the server) so
 * tests can assert the active registration set — e.g. that a removed
 * provider (R4) stays unregistered and a historical cache row cannot
 * resurrect it after a restart.
 */
import { config } from '../config.js';
import type { ProviderManager } from '../provider-manager.js';
import type { ProviderAdapter } from '../types.js';
import { AlibabaQwen } from './alibaba-qwen.js';
import { Brave } from './brave.js';
import { Claude } from './claude.js';
import { Codex } from './codex.js';
import { CommandCode } from './commandcode.js';
import { Context7 } from './context7.js';
import { DeepSeek } from './deepseek.js';
import { Evolink } from './evolink.js';
import { Firecrawl } from './firecrawl.js';
import { Grok } from './grok.js';
import { Kimi } from './kimi.js';
import { Mimo } from './mimo.js';
import { MiniMax } from './minimax.js';
import { OllamaCloud } from './ollama-cloud.js';
import { OpenCodeGo } from './opencode-go.js';
import { OpenCodeZen } from './opencode-zen.js';
import { OpenRouter } from './openrouter.js';
import { Synthetic } from './synthetic.js';
import { Tavily } from './tavily.js';
import { Zai } from './zai.js';

/** Rate-limited providers — fetched on the slow refresh schedule. */
const SLOW_PROVIDER_IDS: readonly string[] = ['commandcode', 'tavily', 'tavily-2', 'tavily-3'];

export function registerAdapters(manager: ProviderManager): void {
  const adapters: ProviderAdapter[] = [
    new Brave(),
    new Mimo(),
    new MiniMax(),
    new OpenCodeGo({ apiKey: config.OPENCODE_GO_API_KEY, cdpUrl: config.OPENCODE_GO_CDP_URL }),
    new OpenCodeGo({
      id: 'opencode-go-2',
      name: 'OpenCode Go 2',
      apiKey: config.OPENCODE_GO_2_API_KEY,
      sessionCookie: config.OPENCODE_GO_2_SESSION_COOKIE,
      workspaceId: config.OPENCODE_GO_2_WORKSPACE_ID,
      cdpUrl: config.OPENCODE_GO_2_CDP_URL,
    }),
    new OpenCodeZen(),
    new OllamaCloud(),
    new Claude(),
    new Codex(),
    new CommandCode(),
    new DeepSeek(),
    new Evolink(),
    new Firecrawl(),
    new OpenRouter(),
    new Grok(),
    new Kimi(),
    new Zai(),
    new Synthetic(),
    new AlibabaQwen(),
    new Tavily(),
    new Tavily({
      id: 'tavily-2',
      name: 'Tavily 2',
      apiKey: config.TAVILY_API_KEY_2,
    }),
    new Tavily({
      id: 'tavily-3',
      name: 'Tavily 3',
      apiKey: config.TAVILY_API_KEY_3,
    }),
    new Context7(),
  ];

  for (const adapter of adapters) {
    manager.register(adapter);
  }

  for (const id of SLOW_PROVIDER_IDS) {
    manager.markSlow(id);
  }
}
