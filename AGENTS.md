# AGENTS.md — Project Rules & Conventions

## Language

**English only.** All code, comments, variable names, commit messages, documentation,
UI strings, and any other text in this repository must be in English.

## Mandatory Skill

**Always apply the `style` skill** when writing or modifying code in this project.
The style skill enforces variable placement, function structure, logging patterns,
and maintainability rules that Biome doesn't cover.

## Code Quality

This project uses **Biome** as the sole linter and formatter. No ESLint, no Prettier.

Run before committing:
```bash
npm run check        # full suite: biome + knip + cspell + gitleaks + jscpd
npm run lint         # biome check only
npm run format       # biome format
```

### Biome rules (key highlights)

- **No `any`** — `noExplicitAny: error`
- **No `==`** — `noDoubleEquals: error` (use `===`)
- **No `forEach`** — `noForEach: error` (use `for..of`)
- **No `else` after early return** — `noUselessElse: error`
- **No parameter mutation** — `noParameterAssign: error` (property assignments also denied)
- **No non-null assertions** — `noNonNullAssertion: error`
- **Prefer arrow functions** — `useArrowFunction: error`
- **Prefer optional chaining** — `useOptionalChain: error`
- **Prefer template literals** — `useTemplate: error`
- **Prefer `const`** — `useConst: error`
- **Use block statements** — single-line `if` bodies must be wrapped in `{}`
- **Use `Number.isFinite`/`Number.isNaN`** — no global `isFinite`/`isNaN`
- **Use `Number` namespace** — `Number.parseInt`, `Number.POSITIVE_INFINITY`, etc.
- **No `console.log`** — use `console.info/warn/error` instead
- **No delete operator** — `noDelete: warn`
- **No accumulating spread** — `noAccumulatingSpread: error`
- **Cognitive complexity** — warn when > 12

## Git Hooks (Lefthook)

- **pre-commit** — biome format + lint staged files, gitleaks quick scan, cspell
- **commit-msg** — conventional commits enforced (`feat:`, `fix:`, `chore:`, etc.)
- **pre-push** — knip (unused code check) + gitleaks full history scan

## Additional Checks

| Tool      | Purpose                              | Command              |
|-----------|--------------------------------------|----------------------|
| Knip      | Unused files, deps, exports          | `npm run knip`       |
| CSpell    | Spellcheck (English + Russian dict)  | `npm run spellcheck` |
| Gitleaks  | Secret/credential detection          | `npm run secrets`    |
| jscpd     | Copy-paste detection                 | `npm run dupes`      |

## Project Structure

```
src/
├── index.ts              # Hono server entry point
├── service.ts            # Provider orchestration & caching
├── store.ts              # SQLite cache (sync via better-sqlite3)
├── html.ts               # Dashboard HTML rendering
├── adapters/
│   ├── types.ts          # Shared interfaces (UsageWindow, Provider, etc.)
│   ├── codex.ts          # OpenAI Codex adapter
│   ├── minimax.ts        # MiniMax Token Plan adapter
│   ├── ollama-cloud.ts   # Ollama Cloud adapter
│   └── opencode-go.ts    # OpenCode Go adapter
└── design/themes/        # 10 CSS theme files
```

## Dev Server

The dev server is started by the **user**, not the agent:

```bash
npm run dev        # tsx watch — auto-reloads on file changes
```

- The agent must **never** kill, restart, or otherwise touch the dev server process.
- The agent makes code changes; `tsx watch` picks them up automatically.
- If a port conflict occurs, the user handles it.

## Conventions

- **Imports**: `node:` protocol for built-ins (`import { readFileSync } from 'node:fs'`)
- **Types**: `import type` for type-only imports
- **Modules**: ESM (`"type": "module"`)
- **Runtime**: Node.js, TypeScript compiled via `tsx` (dev) / `tsc` (build)
- **Indent**: 2 spaces
- **Quotes**: single quotes
- **Semicolons**: always
- **Trailing commas**: always
- **Line width**: 100
- **Naming**: prefer short, 1-word names for internal helpers (e.g., `fetchHtml` not `fetchWorkspaceHtml`)
- **No external directory access** — code must NOT read files from `~/.pi`,
  `/home`, or any path outside the project root. All credentials and config
  come from environment variables only.
