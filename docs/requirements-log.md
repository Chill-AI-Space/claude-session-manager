# Requirements Log — claude-session-manager

Running log of features/decisions for this project, with status. Update in place rather than creating new dated files — this is meant to survive `/clear` and session handoffs.

## Implemented

- **Telegram bridge** (separate repo `~/Code/asisstent-william-bot`, Cloudflare Worker):
  - Stop-hook (`~/.config/claude-hooks/plugins/Stop/telegram-notify.ts`) sends a Telegram summary after every turn, linking `telegram_message_id -> {node_id, session_id}` so replies route back.
  - Voice notes transcribed via Deepgram (nova-2, ru) before routing, both in Telegram and in the web UI (mic button + `/api/transcribe`, key stored as `deepgram_api_key` setting).
  - `/create-session <prompt>` Telegram command: guesses project folder by keyword match, offers an inline-keyboard picker (incl. "➕ Новая папка" to create one) when unsure, starts via relay.
  - Token-budget warnings at 50/75/90% of an assumed ~15M session budget (`~/.claude/session-token-warnings.json`), nudging toward writing a doc + `/clear` before a real auto-compact hits.

- **csm-relay** (Cloudflare Worker + Durable Object, in `workers/relay/`): bridges the Telegram/web side to this Mac. `resume` and `start` actions open real interactive terminals (`openInTerminal`), never headless `-p` — headless spawns fork the transcript when the target session is still live. `start` can also create the target folder (`createIfMissing`) and pre-accepts the one-time "trust this folder" dialog (`src/lib/trust-project.ts`) so an unattended first launch doesn't hang forever.

- **Live-session detection**: `~/.claude/session-pid-map.json`, written by the Stop hook from its own parent PID, is the authoritative source for "which process is this session" — `detectActiveClaudeSessions()`'s cwd-based heuristic is ambiguous whenever several sessions share a working directory (common here, many sessions run rooted at `~/Code`).

- **Web UI (`localhost:3000/claude-sessions`)**:
  - New-session composer and reply box both have voice input (record → Deepgram → insert text), same pattern as Telegram.
  - "+ New" button forces a remount (`?new=<ts>` query key) — a same-URL `<Link>` was a no-op in the App Router.
  - Agent picker now syncs from the `default_agent` setting instead of being hardcoded to "codex".
  - Folder picker: creating a folder that already exists (e.g. an existing project) navigates into it instead of erroring on `EEXIST`.
  - New sessions started from the composer (`/api/sessions/start`, plain "claude" agent, non-automated spawns only) open a real terminal instead of running headless — needed for things like the Chrome extension, which only pairs with a real terminal-attached process, not a piped/headless one. Automated/delegated spawns (`reply_to_session_id`/`on_complete_url`/`previous_session_id` set) still go through the original headless `orch.start()`, since the DB bookkeeping for those features lives there.
  - `default_agent` setting switched from `codex` to `claude`.
  - `ai-client.ts` gained an `openrouter` provider (model ids with a `/`) — title/summary/learnings generation was hard-failing on Google AI's free-tier quota; switched those to `openai/gpt-4o-mini` via OpenRouter.
  - Health-check watchdog (`scripts/tray.js`) debounced — was SIGKILL-restarting on a single slow `/api/settings` response under load; now requires two consecutive failures 6s apart.

## Implemented (iTerm2 delivery fixes)

**Two-phase unique-ID session targeting** (`src/lib/macos-terminal-control.ts`, commits `12a0951`, `c1a61ad`):
- Phase 1 (read-only): scan all iTerm2 sessions for one matching the target TTY, capture its `unique ID` (UUID-like, stable per session lifetime). No `select`/`activate` calls — the mis-binding bug was observed specifically when those were made while the session variable was still live.
- Phase 2: fresh scan by `unique ID`, then `select s` + `tell s to write text`. The write goes to the precisely identified session, not whatever iTerm's object binding resolves to after focus operations.
- Eliminated the in-AppleScript post-write `contents of s` verification (was a readback through the same potentially mis-bound object, so it always agreed with the wrong delivery).

**Smarter mismatch detection in `sendTextToTerminalTTYVerified`** (commit `bb299ed`):
- Poll window extended from 3 s (10×300 ms) to 6 s (20×300 ms).
- Old: any timeout → `mismatch` error. Caused false-negatives when Claude was busy/crashed mid-turn; text had already been typed into the right terminal, but JSONL hadn't flushed within 3 s → spurious 409 responses.
- New: after polling, read the final transcript state. **Mismatch only if the file grew but doesn't include our marker** (signature of wrong-window delivery: something else wrote to the transcript). If the file didn't grow at all, trust the two-phase delivery — Claude is busy or queued — return `ok: true`.

**Relay WebSocket stability note:** frequent reconnections (~every 5–10 min) observed. Not yet root-caused; messages arriving during a brief disconnect window return 503 from Cloudflare and are silently dropped by the bot.

## Implemented (MD view improvements)

- **"Load N earlier messages" button** (commit `d2d8cea`): `loadAllMdMessages` callback existed but was never wired to any UI. Added clickable button at top of MD view showing count from `mdRenderStart`, spinner while loading.

## Default model → Opus 5.5

- **[реализовано] Модель по умолчанию — Claude Opus 5.5** (`claude-opus-5-5`) для веб-запуска сессий. Меняется `SETTING_DEFAULTS.claude_model` (`src/lib/db.ts`), fallback в `buildCliArgs` (`src/lib/orchestrator.ts`), пресеты в `ModelSelector.tsx`. Документация: `docs/default-model-and-5-5-migration.md`.
- **[реализовано] Список моделей Codex не хардкодится — берётся из `~/.codex/models_cache.json`** (`src/lib/codex-models.ts` → `GET /api/codex/models` → `useAgentModels()`). Хардкод содержал `gpt-5.4`/`gpt-4o`, которых у аккаунта уже нет, и не содержал текущих GPT-6.x. Фильтрует `visibility: "list"` (прячет `gpt-reserve`, `codex-auto-review`), сортирует по `priority`, дефолт — `models[0]`. Статический fallback на случай отсутствия кэша. Дефолт и пресеты теперь резолвятся на рендере (`effectiveModel = picked || default`), а не в effect — раньше codex-дефолт был бы затёрт, когда `/api/codex/models` ещё не ответил. Тесты: `src/lib/__tests__/codex-models.test.ts`.

## Надёжность запуска сессий

- **[реализовано] Длинный промпт запуска больше не ломает терминал** — iTerm2 AppleScript `write text` молча обрезает строку на ~1024 символов; обрезанный `--prompt '<незакрытая кавычка` оставлял шелл в `quote>` (`cmdand quote>`), запуск зависал. Длинные команды теперь пишутся во временный скрипт (`wrapLongCommand`, порог снижен 1200→800, + переносы строк), а промпты Claude/OpenCode/Codex грузятся из temp-файла через `$PROMPT`/`$SYS_PROMPT` (`src/lib/prompt-file.ts`, `session-terminal.ts`, `codex-command.ts`). Команды запуска стали ~300 символов вместо ~1000+. Тесты: `terminal-launcher.test.ts`, `session-terminal.test.ts`.

## Deploy

- **[реализовано] Мягкий деплой на живом сервисе** — `npm run deploy:live` / `scripts/deploy-live.js`: снимок живых сессий → build → рестарт → resume упавших сессий сообщением "сервер передеплоен, восстановлено" → smoke test. Кнопка Update в UI и `scripts/update.sh` вызывают тот же скрипт (`--restart-only`). Ручной `launchctl unload/load` / `pkill` для деплоя запрещён (зафиксировано в CLAUDE.md и README).

## Выбор агента для подсессий

- [реализовано] `subsession_agent_override` — серверное правило: все сессии, заспавненные через curl/API (не из браузерного UI), принудительно запускаются указанным агентом; model сбрасывается. Причина: делегирующий промпт толкал на codex, лимит codex кончался. План: ночь 2026-09-27 → `claude`, утром → `opencode` (Claude — планировщик, opencode — исполнитель-сиблинг).
- [реализовано] Дефолтная подсказка в делегирующем промпте: код → `opencode` (было `codex`), анализ/планирование → `claude`.

## Изоляция параллельных сессий (git worktree)

- [реализовано] `worktree?: boolean` в body `/api/sessions/start`; настройка `sessions_worktree_default` (UI-тоггл, дефолт false для браузера); sub-sessions (без `Sec-Fetch-*`) — дефолт true; явный параметр побеждает. Worktree создаёт сам Session Manager (`git worktree add`), поэтому работает для claude/codex/opencode/forge.
- [реализовано] Ветка `session/<slug>-<timestamp>` от HEAD исходного репо, папка `<repo>/../.worktrees/<repo-name>/<branch>`; подпапка сохраняется; исходный checkout не трогается. `project_path` = worktree, `worktree_source_path`/`worktree_branch` — новые колонки sessions. Status-событие в SSE.
- [реализовано] Фоллбэк: не git / linked worktree / ошибка `git worktree add` → старт в исходном path + logAction + status с причиной.
- [реализовано] Remote nodes: резолвленный `worktree` пробрасывается на VM.
- [реализовано] Консервативная очистка: `GET/POST /api/worktrees` + кнопка в Settings. Удаляет только чистый worktree без уникальных (незапушенных) коммитов и без активной сессии/процесса внутри. Без TTL.
- [ограничение, не решаем] node_modules/.env не копируются, порты общие.
- [отклонено] `claude -w` — только для Claude, не для codex/opencode/forge.

## Папка проекта при спавне (project-path)

- [реализовано] `resolveProjectPath()` (`src/lib/project-path.ts`) вызывается в `/api/sessions/start` перед запуском агента: worktree-путь (`…/.worktrees/<repo>/…` или linked worktree) → `~/Code/<repo>`, иначе владеющий чекаут; несуществующий путь → `~/Code/<basename>`; проекта нет нигде → создаётся `~/Code/<repo>` (`git clone <origin>`, если URL известен — из самого пути или из прошлых `sessions.project_path`, иначе `mkdir`). Лог `session_project_resolved`, note в первом SSE `status`. Никогда не бросает исключение — при сбое старт в исходном пути. Гайд: `docs/spawn-guide.md`.
- [изменено] `sessions_worktree_default` действует одинаково для браузера и для curl-подсессий — убран хардкод «sub-sessions default to true» в `resolveWorktreeDecision`. Изоляция только по явному `"worktree": true`; накопленные `~/Code/.worktrees/*` чистятся вручную (Settings → Session Worktrees).

## Known issues / планируется

- ~~**Сообщение теряется когда сессия занята**~~ — **реализовано** (commit `7dfdecc`): `pendingReplies` Map в orchestrator, доставка на `session:completed`. Ответ юзеру — 200 "Message queued" вместо 409.

- **LLM-фильтрация вместо минус-слов** — идея: дешёвая модель (Gemini 2.0 Flash или LLaMA 3.1 8B) на Cloudflare Worker классифицирует входящие сообщения. 0-40% → пропускаем, 40-75% → понижаем приоритет, 75%+ → отклоняем. Заменяет ручные списки ключевых слов. Нужно согласование с пользователем бота.

- **Relay WebSocket нестабильность** — разрывы ~каждые 5-10 мин, сообщения в окне разрыва теряются (503 от Cloudflare). Не root-caused.

## Rejected / not pursued

- **Fully automatic session rotation via CLAUDE.md instruction alone** — tested against a real 4-hour, 21-turn session; the model never wrote a requirements-log or self-cleared despite the rule being present from the start. Prose instructions in CLAUDE.md are not reliable enough on their own for this; the token-budget-warning hook above is the mechanical backstop instead.
- **Self-triggering `/clear`** — there's no tool for the agent to invoke a slash command on itself; can't be automated from inside a session, only proposed to the user.
