# AI Credentials Dashboard

Monitor and manage your AI service usage in one place. Supports OpenAI Codex, MiniMax Token Plan, Ollama Cloud, and OpenCode Go.

## Features

- **Multi-provider support** — Codex, MiniMax, Ollama Cloud, OpenCode Go
- **SQLite caching** — local storage with configurable TTL
- **10 CSS themes** — from ocean depths to cyberpunk
- **REST API** — JSON endpoints for integration
- **Dashboard UI** — usage overview with provider cards

## Setup

```bash
npm install
cp .env.example .env
# Fill in your API keys in .env
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CODEX_API_KEY` | OpenAI Codex API key |
| `MINIMAX_COOKIE` | MiniMax cookie for token plan |
| `OLLAMA_CLOUD_API_KEY` | Ollama Cloud API key |
| `OPENCODE_GO_API_KEY` | OpenCode Go API key |
| `TAVILY_API_KEY` | Tavily API key for usage endpoint |
| `CONTEXT7_API_KEY` | Context7 API key for library metrics |
| `CONTEXT7_LIBRARY_IDS` | Comma-separated library IDs to monitor |
| `SQLITE_PATH` | Path to SQLite database (default: `./cache.db`) |
| `CACHE_TTL` | Cache TTL in seconds (default: `3600`) |
| `PORT` | Server port (default: `3000`) |
| `THEME` | CSS theme name (default: `ocean-depths`) |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Dashboard HTML |
| `GET` | `/api/usage` | All providers usage |
| `GET` | `/api/usage/:provider` | Single provider usage |
| `GET` | `/api/themes` | Available themes |

## Available Themes

- `ocean-depths` — deep blue ocean palette
- `sunset-boulevard` — warm orange/pink gradient
- `forest-canopy` — earthy greens
- `neon-nights` — dark with neon accents
- `paper-ink` — high contrast black/white
- `arctic-frost` — cool silver/white
- `desert-dunes` — sandy beige/brown
- `cyberpunk` — neon pinks and blues
- `zen-garden` — calm minimalist
- `retro-wave` — 80s retro colors

## Development

```bash
npm run dev       # Start dev server with hot reload
npm run check     # Run all quality gates
npm run lint      # Biome lint only
npm run format    # Biome format
npm run knip      # Check for unused code
npm run spellcheck # Spellcheck
npm run secrets   # Secret detection
npm run dupes     # Copy-paste detection
```

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **Server:** Hono
- **Database:** SQLite (better-sqlite3)
- **Styling:** 10 hand-crafted CSS themes
- **Linting:** Biome
- **Spellcheck:** CSpell
- **Secret detection:** Gitleaks
