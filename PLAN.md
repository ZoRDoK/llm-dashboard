# AI News Board — план

## Context
Добавить в правую часть дашборда борду с новостями из AI источников.

**Интересует:**
- Новые модели облачных провайдеров (не локальные)
- AI coding tools (Cursor, Copilot, etc.)
- Harness фреймворки (lm-evaluation-harness, inspect, etc.)
- Обсуждения в Reddit

**Не интересует:** AGI, локальные модели, бенчмарки

## Sources

### Reddit (Pushshift API для горячих постов)

| Источник | URL | Описание |
|---------|-----|----------|
| r/LocalLLaMA | pushshift.io/reddit/search | Облачные провайдеры, API, цены, новые модели. Самый живой поток обсуждений |
| r/programming | pushshift.io/reddit/search | AI coding tools, IDE плагины |
| r/SideProject | pushshift.io/reddit/search | Интересные AI проекты |

### GitHub Releases (API)

| Источник | URL | Описание |
|---------|-----|----------|
| lm-evaluation-harness | api.github.com/repos/EleutherAI/lm-evaluation-harness/releases | Главный harness для evals моделей |
| vLLM | api.github.com/repos/vllm-project/vllm/releases | Производительный inference сервер |
| LiteLLM | api.github.com/repos/BerriAI/litellm/releases | Универсальный LLM прокси |
| Cursor | github.com/getcursor/Cursor/releases | AI IDE |

### Tech Blogs (RSS)

| Источник | RSS URL | Описание |
|---------|---------|----------|
| OpenAI Blog | openai.com/blog/rss.xml | Официальные анонсы GPT, API |
| Anthropic Blog | anthropic.com/news/rss | Claude, Constitutional AI |
| Google DeepMind | deepmind.google/blog/rss | Gemini, исследования |
| Hugging Face Blog | huggingface.co/blog/feed.xml | Новые модели, datasets |
| Cursor Changelog | cursor.com/changelog/rss | Обновления IDE |

### Aggregators

| Источник | URL | Описание |
|---------|-----|----------|
| Hacker News (AI filter) | hn.algolia.com/api/v1/search?query=AI | Горячие обсуждения с фильтром |
| Last Week in AI | lastweekin.ai | Еженедельный дайджест |

## Priority Sources (v1)

1. **r/LocalLLaMA** — главный источник обсуждений
2. **OpenAI Blog RSS** — официальные анонсы
3. **GitHub Releases** — vLLM, lm-evaluation-harness, LiteLLM
4. **Cursor Changelog** — AI coding updates

## Approach

1. Создать `src/adapters/news-sources.ts` с адаптерами для каждого типа
2. Добавить GitHub releases polling (периодический)
3. Добавить Reddit hot posts fetching (pushshift.io API)
4. Добавить RSS парсинг для блогов
5. Агрегировать в единый поток с timestamp и source
6. Рендерить справа в collapsible секции
7. Обновлять периодически (каждые 15-30 минут)

## Files to modify/create

- `src/adapters/news-sources.ts` — новый адаптер с источниками
- `src/html.ts` — рендер news section справа
- `src/index.ts` — интеграция в polling loop

## Verification

- Новости отображаются справа
- Обновление без перезагрузки страницы
- Клик на новость открывает оригинал
- Collapsible чтобы не мешало
