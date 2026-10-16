import { z } from 'zod';

const MIN_PORT = 3000;
const MAX_PORT = 4000;
const DEFAULT_PORT = 3001;

// Silent-SSO keepalive interval (hours) for the Alibaba Qwen console; 0 disables it.
const DEFAULT_ALIBABA_QWEN_KEEPALIVE_HOURS = 6;

// Read-only root of pi coding agent session logs (P Charts page).
const DEFAULT_PI_SESSIONS_DIR = '~/.pi/agent/sessions';

// Web UI of the containerized Chrome used for manual logins; named in errors
// and alerts so a dead console session is one click from its login surface.
const DEFAULT_CHROME_UI_URL = 'http://127.0.0.1:13000';

// Watchdog defaults — see the WATCHDOG_* fields below for meaning.
const DEFAULT_WATCHDOG_STALE_HOURS = 3;
const DEFAULT_WATCHDOG_MAX_RUNS_PER_DAY = 2;
const DEFAULT_WATCHDOG_TICK_MINUTES = 15;
// Absolute path: the systemd service PATH may lack ~/.local/bin.
const DEFAULT_WATCHDOG_PI_PATH = '/home/slava/.local/bin/pi';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(MIN_PORT).max(MAX_PORT).default(DEFAULT_PORT),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
    .default(process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  CHROME_CDP_URL: z.string().optional(),
  BRAVE_COOKIE: z.string().optional(),
  MIMO_COOKIE: z.string().optional(),
  MIMO_API_URL: z.string().optional(),
  MINIMAX_API_KEY: z.string().optional(),
  OLLAMA_CLOUD_API_KEY: z.string().optional(),
  OPENCODE_GO_SESSION_COOKIE: z.string().optional(),
  OPENCODE_GO_WORKSPACE_ID: z.string().optional(),
  OPENCODE_GO_2_SESSION_COOKIE: z.string().optional(),
  OPENCODE_GO_2_WORKSPACE_ID: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENAI_CODEX_ACCESS_TOKEN: z.string().optional(),
  CLAUDE_ACCESS_TOKEN: z.string().optional(),
  GROK_ACCESS_TOKEN: z.string().optional(),
  GROK_COOKIE: z.string().optional(),
  TAVILY_API_KEY: z.string().optional(),
  TAVILY_API_KEY_2: z.string().optional(),
  TAVILY_API_KEY_3: z.string().optional(),
  CONTEXT7_API_KEY: z.string().optional(),
  CONTEXT7_SESSION_COOKIE: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  KIMI_API_KEY: z.string().optional(),
  ZAI_API_KEY: z.string().optional(),
  GLM_API_KEY: z.string().optional(),
  ROUTING_RUN_API_KEY: z.string().optional(),
  ROUTING_SH_ACCESS_TOKEN: z.string().optional(),
  ROUTING_SH_ACCOUNT_ID: z.string().optional(),
  EVOLINK_API_KEY: z.string().optional(),
  FIRECRAWL_API_KEY: z.string().optional(),
  SYNTHETIC_API_KEY: z.string().optional(),
  COMMANDCODE_SESSION_TOKEN: z.string().optional(),
  ALIBABA_QWEN_COOKIE: z.string().optional(),
  ALIBABA_QWEN_KEEPALIVE_HOURS: z.coerce
    .number()
    .min(0)
    .default(DEFAULT_ALIBABA_QWEN_KEEPALIVE_HOURS),
  PI_SESSIONS_DIR: z.string().default(DEFAULT_PI_SESSIONS_DIR),
  DESKTOP_NOTIFY: z.coerce.boolean().default(true),
  CHROME_UI_URL: z.string().url().default(DEFAULT_CHROME_UI_URL),
  WATCHDOG_ENABLED: z.stringbool().default(true),
  WATCHDOG_STALE_HOURS: z.coerce.number().positive().default(DEFAULT_WATCHDOG_STALE_HOURS),
  WATCHDOG_MAX_RUNS_PER_DAY: z.coerce
    .number()
    .int()
    .min(1)
    .default(DEFAULT_WATCHDOG_MAX_RUNS_PER_DAY),
  WATCHDOG_TICK_MINUTES: z.coerce.number().int().min(1).default(DEFAULT_WATCHDOG_TICK_MINUTES),
  WATCHDOG_PI_PATH: z.string().default(DEFAULT_WATCHDOG_PI_PATH),
});

export const config = EnvSchema.parse(process.env);
