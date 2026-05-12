import { z } from 'zod';

const MIN_PORT = 3000;
const MAX_PORT = 4000;
const DEFAULT_PORT = 3001;

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(MIN_PORT).max(MAX_PORT).default(DEFAULT_PORT),
  MINIMAX_API_KEY: z.string().optional(),
  OLLAMA_CLOUD_SESSION_COOKIE: z.string().optional(),
  OPENCODE_GO_SESSION_COOKIE: z.string().optional(),
  OPENCODE_GO_WORKSPACE_ID: z.string().optional(),
  OPENAI_CODEX_ACCESS_TOKEN: z.string().optional(),
  TAVILY_API_KEY: z.string().optional(),
  CONTEXT7_SESSION_COOKIE: z.string().optional(),
  CROFS_API_KEY: z.string().optional(),
});

const raw = EnvSchema.parse(process.env);

export const config = {
  port: raw.PORT,
  minimaxApiKey: raw.MINIMAX_API_KEY,
  ollamaCloudSessionCookie: raw.OLLAMA_CLOUD_SESSION_COOKIE,
  openCodeGoSessionCookie: raw.OPENCODE_GO_SESSION_COOKIE,
  openCodeGoWorkspaceId: raw.OPENCODE_GO_WORKSPACE_ID,
  openaiCodexAccessToken: raw.OPENAI_CODEX_ACCESS_TOKEN,
  tavilyApiKey: raw.TAVILY_API_KEY,
  context7SessionCookie: raw.CONTEXT7_SESSION_COOKIE,
  crofsApiKey: raw.CROFS_API_KEY,
};
