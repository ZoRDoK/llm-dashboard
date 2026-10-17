# ai-creds

**English only** for all repository text, including code, UI, docs and commits.
Apply the `style` skill when changing code. Biome is the sole linter/formatter;
`biome.json` defines formatting and lint rules rather than this file duplicating them.

## Source map

Node.js/TypeScript ESM dashboard using Hono, Zod, Tailwind and Pino.

- `src/index.ts`: server startup/routes, bound to loopback; `src/config.ts`: env validation
  and defaults (`PORT` defaults to 3001).
- `src/provider-manager.ts`: polling, caching and refresh coordination;
  `src/adapters/registry.ts`: active adapters and slow-poll registration, not historical cache rows.
- `src/types.ts`: shared interfaces; `src/provider.ts`, `src/usage-window.ts`: domain objects.
- `src/store.ts`: built-in `node:sqlite`; `data/cache.sqlite` also holds settings and history.
- `src/html.ts`, `src/html/`, `design/`: dashboard, client script, Tailwind and themes.
- `src/pi-usage.ts`: session-usage analytics; `src/watchdog.ts`: scheduled repair-agent launches.
- `tests/`: Vitest unit/rendering tests and separate Playwright-backed browser E2E tests.

## Commands

```bash
npm run dev            # tsx watch, loads .env
npm run build          # Tailwind + tsc + design assets into dist/
npm start              # compiled server, loads .env
npm test               # unit/rendering tests; excludes browser E2E
npm run test:e2e        # browser E2E against an existing server
npm run test:coverage   # unit/rendering coverage
npm run lint           # Biome only
npm run check          # Biome + Knip + CSpell + Gitleaks + jscpd; NOT tests
```

`package.json` is authoritative. E2E uses `E2E_BASE_URL` (default `http://localhost:3002`),
not the default app port. Use an authorized isolated server, not production.
For docs-only changes, use focused document checks and normal hooks, not app tests or startup.
Starting `src/index.ts` polls providers, writes SQLite/auth caches and may launch repair agents.

## Boundaries

- Runtime credentials use env, existing OAuth `auth.json` flows in `src/adapters/*-auth.ts`,
  and CDP/local `data/` caches. OAuth refresh may persist tokens to its existing external paths.
  `PI_SESSIONS_DIR` analytics reads sessions only and stores aggregates in local SQLite.
  Do not add external paths or credential sources without explicit approval.
- These runtime flows do not authorize agent access: inspecting or editing live `.env`, `data/`,
  credential stores, browser cookies or raw session logs requires an explicit operator request.
  Never disclose, log or commit secrets. Use `src/logger.ts` for application logging.
- Preserve live SQLite/WAL, billing/archive settings, quota history and watchdog state.
  Keep per-provider in-flight coalescing, slow-poll/archive rules and stale timestamps intact;
  never restore retired adapters just because cached rows remain.
- Live provider/CDP probes, paid calls, service starts/restarts, deployment and publication
  require explicit authorization; documentation work is not authorization.
- Preserve unrelated staged/untracked work; commit only the task's files with normal Lefthook
  hooks and Conventional Commits. Never push without a user request.
- Delegate only when useful or requested; keep writer ownership explicit and avoid overlap.
