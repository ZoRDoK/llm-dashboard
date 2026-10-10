# Progress

## Status
Whole-project refactor done (jscpd 21 → 7, dashboard byte-identical). New provider: **Alibaba Qwen Token Plan** — weekly quota + reset, shown in the main grid.

## Completed

### Alibaba Qwen Token Plan adapter (new)
- `src/adapters/alibaba-qwen.ts` — Model Studio console gateway (`bailian-singapore-cs.alibabacloud.com/data/api.json`, action `IntlBroadScopeAspnGateway`, product `sfm_bailian`, api `zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage`)
- SEC_TOKEN scraped from the console page HTML (CSRF-bound to session), POST form-encoded with `cornerstoneParam`
- Weekly window: `per1WeekPercentage` → percent used, `per1WeekResetTime` → reset timestamp
- `src/fetch-utils.ts`: `fetchOk` generalized to `RequestInit` + new `postFormJson(url, headers, body)`
- Config/env: `ALIBABA_QWEN_COOKIE` (full cookie header from the console), `.env.example` documented
- Registered in `index.ts`; 3 new unit tests (`buildWeekWindows`: conversion + clamps)
- Auto-refresh like commandcode/context7: cookies persisted to `data/alibaba-qwen-cookies.txt` (gitignored), CDP bootstrap when nothing stored, CDP refresh + one retry when the session expires (SEC_TOKEN missing / gateway error); env cookie stays as the fallback source
- Verified live: plan "Token Plan", weekly percent + reset render in the main grid card

### Shared auth plumbing — new module `src/adapters/auth-json.ts`
- Extracted `expandHome`, `isFresh`, `applyRefreshResponse`, `RefreshResponse`, `AuthJsonStore` (`loadFirst`/`loadAll`/`persist` with 0o600 writes) and abstract `AuthJsonClient<Entry>` (shared cache/getToken/clearCache, hooks `entryKey()/label()/refreshEntry()`)
- Provider specifics preserved: Anthropic retry/backoff + `invalid_grant`/`rate_limit_error` body sniffing stays in `claude-auth.ts`; `GrokAuth` posts form-urlencoded to `entry.tokenEndpoint`; `CodexAuth` keeps its own multi-file `getToken` (loadAll + `openai-codex`/`openai` fallback + continue-on-refresh-error) via `AuthJsonStore`
- New `retryOn401(token, fromAuth, auth, run)` — the clearCache + force-fresh-once pattern used by claude/codex/grok lives in one place

### HTTP helpers — `src/fetch-utils.ts`
- Private `fetchOk(url, headers)` — single place for the timeout + `HTTP <status>` throw
- `fetchJson(endpoint, apiKey)` — public contract unchanged (Bearer header set is deep-equalsed by tests)
- `fetchJsonWith(url, headers)` — custom-header JSON (claude/codex/mimo context7-style)
- `fetchText(url, headers)` — HTML/NDJSON (opencode-http, ollama-cloud, brave)
- `fetchAndParse<T>(endpoint, apiKey, schema)` — Bearer + zod.parse; 8 adapters now one-liners

### Shared constants and small helpers
- `CHROME_USER_AGENT` in `src/constants.ts` (brave/ollama-cloud/opencode-http/context7/commandcode)
- `src/data-file.ts` — `readDataFile`/`writeDataFile` (commandcode token + context7 cookies persistence; empty-file vs missing-file semantics preserved)

### HTML — `src/html.ts` 679 → ~330 lines
- Inline client `<script>` (~317 lines) moved to `src/html/client-script.ts` — `clientScript({ themeNames, refreshCircumference })`
- Client JS: two duplicated elapsed-time ladders folded into one `formatElapsedMs`
- `renderDashboard` split into `documentHead/dashboardHeader/responsivePanels/dashboardTab/settingsTab/dataTabs`
- `src/html/usage-renderers.ts`: new `findWindow`, `updatedLabelSpan`, `emptyState` helpers
- `compact-panel.ts`: ten per-provider extractors replaced by the data-driven `COMPACT_LINES` map (257 → ~160 lines)
- `urgent-panel.ts`: `renderUrgentMode`/`renderDesirableMode` merged into `renderModePanel(items, dotClass, title)`

### Verification
- `scripts/render-snapshot.ts` renders a frozen-Date dashboard; before/after diff contains only the intended elapsed-ladder fold — no markup drift
- Unit tests: 339/339 ✓; tsc ✓; biome ✓; knip ✓; cspell ✓; gitleaks ✓
- E2E: 6/6 against a live server (BASE_URL is now overridable via `E2E_BASE_URL` env var — useful when another app occupies :3002)
- jscpd clones: 21 → 7 (remaining are import-block declarations and identical adapter idioms)

## Pending user action

### Grok — refresh token revoked
- `~/.pi/agent/auth.json` `xai-auth` entry exists but refresh token was revoked by xAI (`invalid_grant`)
- Access token expired 2026-06-06
- Fallback env var `GROK_ACCESS_TOKEN` not set in `.env`
- Code handles: auth.json refresh → fails → env var — not set → `Not configured`

### Context7 — needs API key
- `CONTEXT7_API_KEY` in `.env` (format: `ctx7sk-...`), get at https://context7.com/dashboard

### MiMo — cookie expired
- `MIMO_COOKIE` in `.env` needs refreshing — re-copy cookie from the browser session on https://platform.xiaomimimo.com

### Chrome CDP — auto-refresh wired to the containerized Chrome
- The logged-in Chrome runs in the `neurovanya-chrome` container (CDP on loopback inside it)
- New `scripts/cdp-proxy.mjs` + user systemd unit `ai-creds-cdp-proxy.service` bridge `127.0.0.1:9333` into the container's CDP via `docker exec` pipes — survives container restarts and host reboots, zero changes to the container
- New env `CHROME_CDP_URL` (config.ts + browser-cookies.ts, default `http://127.0.0.1:9222`); `.env` points it at `http://127.0.0.1:9333`
- Verified: Playwright `connectOverCDP` reads cookies through the proxy (ok path); sites are simply not logged in inside that Chrome yet
- To activate: log into modelstudio.console.alibabacloud.com / context7 / commandcode inside the container Chrome — adapters then self-heal with no code changes. Alternative: start the host Chrome with `--remote-debugging-port=9222` and remove `CHROME_CDP_URL` from `.env`
- Deployment note: the dashboard is managed by systemd user unit `ai-creds.service` (port 3102) — deploy via `npm run build && systemctl --user restart ai-creds`
