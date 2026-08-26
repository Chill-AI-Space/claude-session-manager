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

## Known issue — not yet root-caused

**iTerm2 AppleScript session mistargeting.** Confirmed live, repeatedly: `sendTextToTerminalTTY` matches the target session by `tty of s`, but iTerm sometimes binds `s` to a *different* live session anyway — and because the write and a same-object readback both go through that same mis-bound `s`, every AppleScript-internal check agrees with the wrong delivery. Fixed the *safety* side: `sendTextToTerminalTTYVerified` now polls the target session's own `.jsonl` transcript file on disk (ground truth, untouched by iTerm's object binding) and only reports success once the payload actually appears there — a wrong-session delivery is now a reported failure (`reason: "mismatch"`) instead of a silent misdelivery. The *root cause* is still open — candidate next step: match sessions by something other than `tty` (e.g. iTerm's own `unique id`), since `tty`-based matching is apparently not reliable in this iTerm2 version/config.

## Rejected / not pursued

- **Fully automatic session rotation via CLAUDE.md instruction alone** — tested against a real 4-hour, 21-turn session; the model never wrote a requirements-log or self-cleared despite the rule being present from the start. Prose instructions in CLAUDE.md are not reliable enough on their own for this; the token-budget-warning hook above is the mechanical backstop instead.
- **Self-triggering `/clear`** — there's no tool for the agent to invoke a slash command on itself; can't be automated from inside a session, only proposed to the user.
