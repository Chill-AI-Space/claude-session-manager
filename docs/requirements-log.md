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

## Known issues / планируется

- **Сообщение теряется когда сессия занята** — `reply/route.ts` ретраит 5×4 с=20 с, после чего возвращает 409 и сообщение пропадает. Нет очереди. Нужно: добавить pending message queue в orchestrator — если сессия занята, держать сообщение и доставлять когда завершится тёрн.

- **LLM-фильтрация вместо минус-слов** — идея: дешёвая модель (Gemini 2.0 Flash или LLaMA 3.1 8B) на Cloudflare Worker классифицирует входящие сообщения. 0-40% → пропускаем, 40-75% → понижаем приоритет, 75%+ → отклоняем. Заменяет ручные списки ключевых слов. Нужно согласование с пользователем бота.

- **Relay WebSocket нестабильность** — разрывы ~каждые 5-10 мин, сообщения в окне разрыва теряются (503 от Cloudflare). Не root-caused.

## Rejected / not pursued

- **Fully automatic session rotation via CLAUDE.md instruction alone** — tested against a real 4-hour, 21-turn session; the model never wrote a requirements-log or self-cleared despite the rule being present from the start. Prose instructions in CLAUDE.md are not reliable enough on their own for this; the token-budget-warning hook above is the mechanical backstop instead.
- **Self-triggering `/clear`** — there's no tool for the agent to invoke a slash command on itself; can't be automated from inside a session, only proposed to the user.
