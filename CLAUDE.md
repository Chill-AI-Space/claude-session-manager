# Claude Session Manager

Next.js app (App Router) + better-sqlite3. Web UI for browsing and managing Claude Code sessions.

**Cross-platform:** works on macOS, Windows, and Linux.

## Stack

- Next.js 16 (Turbopack in dev), React 19, Tailwind CSS 4, shadcn/ui
- Database: `data/sessions.db` (SQLite via better-sqlite3)
- Settings: `~/.config/claude-session-manager/settings.json` (JSON file, NOT in DB)

## Commands

```bash
npm run dev          # dev server with Turbopack (http://localhost:3000)
npm run build        # production build
npm run start        # production server (http://localhost:3000)
```

## macOS quick start

Prerequisites: **Node.js 18+** (20+ recommended), **Git**.

```bash
git clone https://github.com/Chill-AI-Space/claude-session-manager.git
cd claude-session-manager
npm install
scripts/install-mac.sh
```

`install-mac.sh` does everything: builds the project, creates a launchd service (auto-starts on login), and verifies the server + menu bar icon are running.

After install: white spiral icon appears in the menu bar (Open Session Manager / Babysitter ON-OFF / Quit).

**Uninstall:** `scripts/install-mac.sh --uninstall`

Optional extras:
- **Claude CLI** (`npm i -g @anthropic-ai/claude-code`) — needed to start/reply to sessions from the UI
- **ripgrep** (`brew install ripgrep`) — faster text search across sessions
- **Gemini API key** — free at https://aistudio.google.com/apikey, add `GEMINI_API_KEY=your_key` to `.env.local` for AI-powered search

After starting, go to **Settings → System Setup** to see which components are detected and what's missing.

### Smoke test

```bash
scripts/smoke-test.sh
```

Works on both fresh installs (0 sessions) and populated instances. On clean install, data-dependent checks are skipped gracefully.

## Windows setup (one-click)

Prerequisites: **Node.js 18+** (https://nodejs.org). Git optional (can download zip).

```
git clone <repo-url>
cd claude-session-manager
scripts\setup-windows.bat
```

The script will: check Node.js → `npm install` → `npm run build` → start server → open browser.

To update later: `scripts\update.bat`

### Windows limitations

- **Process detection** — `ps`/`lsof` not available; active session detection is disabled (`process-detector.ts` returns `[]` on Windows). Sessions still show but without live "active" status.
- **Kill session** — SIGTERM-based terminal kill is not supported. The UI shows a warning on the Help page.
- **Tray icon** — systray2 works on Windows but the icon is optimized for macOS dark menu bar (white on transparent). It will appear but may look odd on Windows taskbar.
- **Permission bridge hook** — uses `permission-bridge.cmd` on Windows (not `.sh`). The `.cmd` script must exist in `scripts/` for the install feature to work.
- **Claude CLI path** — resolved via `where claude` on Windows. If Claude is installed via npm global, WinGet, or to a custom path, it should be in PATH.

## Deploy workflow

Always test on dev first, then deploy to production.
**MANDATORY: After every deploy, run the health checks (step 3). If any check fails — fix and redeploy. Do NOT consider the deploy done until all checks pass.**

### 1. Start dev server and verify

```bash
cd ~/Documents/GitHub/claude-session-manager
lsof -ti:3000 | xargs kill -9 2>/dev/null
rm -rf .next
npm run dev
```

Verify your changes work:
- Open http://localhost:3000 and check the UI
- For settings changes: `curl http://localhost:3000/api/settings | jq .your_key`
- For new UI sections: navigate to the page and confirm it renders

### 2. Build and restart production (via launchd)

Production runs as a **launchd service** (NOT nohup). The entrypoint is `scripts/tray.js` which:
- Shows a **macOS menu bar icon** (Quasar symbol, grayscale, via `systray2`)
- Spawns `next start` as a child process
- Menu: "Open Session Manager" (opens browser) | "Quit" (stops server + tray)

Logs go to `~/Library/Logs/`, not `/tmp/`.

Stop dev (Ctrl+C), then:

```bash
cd ~/Documents/GitHub/claude-session-manager
npm run build 2>&1 | tail -5
# ↑ MUST see "prerendered as static content" / route list at the end
# If build fails — fix the error, do NOT proceed

# Restart the launchd service (it will auto-start on reboot too)
launchctl unload ~/Library/LaunchAgents/com.vova.claude-sessions.plist
sleep 1
launchctl load ~/Library/LaunchAgents/com.vova.claude-sessions.plist
sleep 3
```

### 3. Post-deploy health checks (MANDATORY)

Run the smoke test after every deploy. It verifies server, APIs, data loading, MD pagination, and content rendering — not just HTTP 200.

```bash
# API smoke test (fast, 13 checks — server, APIs, data)
scripts/smoke-test.sh

# Browser smoke test (headless Chrome — catches React errors, hangs, empty UI)
node scripts/browser-smoke-test.mjs
```

Both must pass. If any check fails — fix before considering the deploy done.

For individual manual checks:

```bash
# 1. Server process is alive
lsof -i:3000 | grep LISTEN

# 2. Main page responds 200
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/claude-sessions

# 3. API responds with JSON
curl -s http://localhost:3000/api/sessions | head -c 200

# 4. Settings API responds
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/settings

# 5. No errors in server log (launchd logs, NOT /tmp)
tail -20 ~/Library/Logs/claude-session-manager.log
tail -20 ~/Library/Logs/claude-session-manager-error.log

# 6. Debug log pipeline ping (non-blocking — skip if debug_log_endpoint not set)
curl -s -X POST http://localhost:3000/api/debug/ping | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'Debug ping: {d[\"status\"]} ({d.get(\"totalMs\",\"?\")}{\"ms\" if \"totalMs\" in d else \"\"})')"
```

**If any check fails:**
1. Check `tail -50 ~/Library/Logs/claude-session-manager-error.log` for the error
2. If process died — `rm -rf .next`, rebuild, reload launchd
3. If port busy — `lsof -ti:3000 | xargs kill -9`, then `launchctl load ...`
4. Fix the root cause and redeploy from step 2

### Common issues (macOS)

- **Turbopack cache corruption** — `rm -rf .next` and rebuild
- **Port 3000 busy** — `lsof -ti:3000 | xargs kill -9`
- **Process dies silently after "Ready"** — check `tail -50 ~/Library/Logs/claude-session-manager-error.log`, likely a runtime import error
- **"signal is aborted without reason"** — always pass a reason to `abort()`, e.g. `abort("cancelled")`
- **Build fails on `/_global-error`** — clear `.next` cache and rebuild
- **`spawn claude ENOENT`** — launchd PATH doesn't include `/Users/vova/.local/bin`. Fix: edit `~/Library/LaunchAgents/com.vova.claude-sessions.plist`, add `/Users/vova/.local/bin` to PATH, reload launchd.
- **Tray icon not appearing** — run `node scripts/tray.js` manually to debug. If `tray_darwin_release` gets EACCES: `find ~/.cache/node-systray -name 'tray_darwin_*' -exec chmod +x {} \;`
- **launchd keeps restarting/dying** — check `launchctl list com.vova.claude-sessions` for LastExitStatus; check both log files.

### Common issues (Windows)

- **`npm install` fails on better-sqlite3** — needs C++ build tools. Fix: `npm install --global windows-build-tools` or install "Desktop development with C++" from Visual Studio Build Tools (https://visualstudio.microsoft.com/visual-cpp-build-tools/). Node 18+ with recent npm usually has prebuilt binaries and skips compilation.
- **Port 3000 busy** — `netstat -aon | findstr ":3000" | findstr "LISTENING"` to find PID, then `taskkill /f /pid <PID>`
- **`spawn claude ENOENT`** — Claude CLI not in PATH. Run `where claude` to check. Install: `npm install -g @anthropic-ai/claude-code`
- **CMD window flashes** — all spawns use `windowsHide: true`, but if a CMD still flashes, check that the spawn has this option set
- **Turbopack cache corruption** — `rmdir /s /q .next` and rebuild

### Dev debugging

Run `npm run dev` in foreground to see server errors. Client-side React errors only appear in the browser console / Next.js error overlay.

## Settings system

Settings are stored in `~/.config/claude-session-manager/settings.json` as a flat `{ key: value }` JSON object.

### API

- `GET /api/settings` — returns all settings (defaults merged with saved)
- `PUT /api/settings` — body `{ "key": "value" }`, saves and returns all settings

### Adding a setting from another project

To register a new setting that appears in the Session Manager UI:

1. Add default value in `src/lib/db.ts` → `SETTING_DEFAULTS`
2. Add UI controls in `src/app/claude-sessions/settings/page.tsx`
3. Add search keyword in the `searchIndex` map (same file) so the setting is discoverable via search
4. Deploy (see above)

To just read/write a setting programmatically without UI changes:

```bash
# Read all settings
curl http://localhost:3000/api/settings

# Write a setting
curl -X PUT http://localhost:3000/api/settings \
  -H "Content-Type: application/json" \
  -d '{"my_setting_key": "value"}'
```

Settings are immediately available — no restart needed. The UI reads them on page load.

## Session Orchestrator (`src/lib/orchestrator.ts`)

Centralized session lifecycle manager. All session operations (start, resume, stop, crash retry, stall continue) go through the orchestrator. API routes are thin wrappers.

### Architecture

```
  Consumers (UI routes, remote relay, CLI, GCP VM)
       │
       ▼
  SessionOrchestrator (singleton via globalThis)
       │
       ├── start(projectPath, message) → ReadableStream (SSE)
       ├── resume(sessionId, message, projectPath) → ReadableStream (SSE)
       ├── stop(sessionId) → { killed, pids }
       ├── status(sessionId) → SessionState | null
       ├── enqueueCrashRetry(sessionId, jsonlPath)
       ├── enqueueStallContinue(sessionId)
       ├── enqueueIncompleteExitResume(sessionId, jsonlPath)
       ├── enqueuePermissionEscalation(sessionId)
       └── enqueue({ sessionId, type, message, priority, delayMs }) → taskId
                │
                ▼
           TaskQueue (priority + concurrency + dedup)
```

### Key concepts

- **TaskQueue** — priority queue (high/normal/low) with concurrency limit (`orchestrator_max_concurrent`, default 3). Dedup by task ID (`type:sessionId`). Tasks can have delay (replaces old `setTimeout`). Delayed tasks wait in a timer, then enter the pending queue.
- **State machine** — per-session phases: `idle → running → completed | crashed → retrying → running | stalled → continuing → running | failed`. States are in-memory only (not persisted to DB). Scanner re-detects crashes/stalls from JSONL on restart.
- **EventEmitter** — emits `session:started`, `session:completed`, `session:crashed`, `session:retrying`, `session:stalled`, `session:continuing`, `session:failed`, `session:stopped`, `session:resumed`, `task:queued`.
- **Singleton** — survives Next.js hot reload via `globalThis.__sessionOrchestrator`.
- **Shared helpers** — `buildCliArgs()` and `parseStreamLine()` eliminate duplication between start/reply routes.

### API endpoints

```bash
# Get orchestrator status (queue + all session states)
curl http://localhost:3000/api/orchestrator

# Enqueue a task (e.g. resume a session remotely)
curl -X POST http://localhost:3000/api/orchestrator \
  -H "Content-Type: application/json" \
  -d '{"type":"resume","sessionId":"UUID","message":"continue please"}'
```

Task types: `start`, `resume`, `crash_retry`, `stall_continue`, `incomplete_exit`, `permission_escalation`.

### Settings

| Key | Default | Description |
|-----|---------|-------------|
| `orchestrator_max_concurrent` | `3` | Max simultaneous Claude processes |
| `orchestrator_crash_retry_delay_ms` | `30000` | Delay before auto-retry after crash |
| `orchestrator_stall_continue_delay_ms` | `10000` | Delay before auto-continue on stall |
| `orchestrator_max_retries` | `3` | Max crash retries per session before marking as failed |

### How scanner integrates (Session Babysitter)

Scanner detects crashes/stalls/incomplete exits during JSONL scan and delegates to orchestrator. Four detection modes:

- **Crash** (`last_message_role === "tool_result"`, new or repeated via `file_mtime` change) → `orchestrator.enqueueCrashRetry(sessionId, jsonlPath)`. The orchestrator checks for permission loops internally and escalates to terminal if needed. Repeated crashes (same `tool_result` role, different mtime) are now detected too.
- **Stall** (`last_message_role === "assistant"`, silent >5min, process still alive) → `orchestrator.enqueueStallContinue(sessionId)`. The orchestrator asks Haiku LLM if Claude is waiting for user input before continuing.
- **Incomplete exit** (`last_message_role === "assistant"`, `has_result = 0`, process dead) → `orchestrator.enqueueIncompleteExitResume(sessionId, jsonlPath)`. This is the "dead zone" case: Claude said "I'll do X" then the process died before executing. The `has_result` flag (presence of `type: "result"` event in JSONL) distinguishes genuine "waiting for reply" from abnormal exit. Post-scan `detectIncompleteExits()` also catches sessions skipped by incremental scan.
- **Permission loop** (repeated permission errors in last 30 JSONL lines) → `orchestrator.enqueuePermissionEscalation(sessionId)`. Opens a terminal session with `--dangerously-skip-permissions`.

### Using from external programs

Any process that can make HTTP requests can control sessions:

```bash
# Start a new session
curl -X POST http://localhost:3000/api/sessions/start \
  -H "Content-Type: application/json" \
  -d '{"path":"/path/to/project","message":"fix the bug in auth.ts"}'

# Resume an existing session
curl -X POST http://localhost:3000/api/sessions/{sessionId}/reply \
  -H "Content-Type: application/json" \
  -d '{"message":"now add tests"}'

# Kill a session
curl -X POST http://localhost:3000/api/sessions/{sessionId}/kill

# Check orchestrator state
curl http://localhost:3000/api/orchestrator

# Enqueue a fire-and-forget task (no SSE stream back)
curl -X POST http://localhost:3000/api/orchestrator \
  -H "Content-Type: application/json" \
  -d '{"type":"resume","sessionId":"UUID","message":"continue","priority":"high"}'
```

Start and reply return SSE streams (`text/event-stream`). Events: `session_id`, `text`, `status`, `done`, `error`.

## Cross-platform development rules

When writing new code, follow these rules to keep Windows compatibility:

- **Home directory**: use `os.homedir()`, never `process.env.HOME` (undefined on Windows)
- **Paths**: use `path.join()`, never hardcode `/`. When splitting paths: `p.split(/[\\/]/)` to handle both separators
- **Binary lookup**: `which` → `where` on Windows. Use `getClaudePath()` from `src/lib/claude-bin.ts`
- **File permissions**: `chmodSync` is a no-op on Windows. Guard with `if (process.platform !== "win32")`
- **Shell commands**: `ps`, `lsof`, `kill`, `grep`, `open` don't exist on Windows. Guard with `process.platform` check or provide Windows alternatives (`tasklist`, `netstat`, `taskkill`, `findstr`, `start`)
- **spawn()**: always pass `windowsHide: true` to prevent CMD popups. Use `shell: true` when spawning `.cmd` files. `detached: true` creates a new process group on Windows (different from Unix) — usually skip it on Windows
- **Signals**: `SIGTERM`/`SIGKILL` work differently. Use `proc.kill()` without arguments for cross-platform compatibility
- **Line endings**: JSONL parsing should handle `\r\n` (use `split(/\r?\n/)`)
- **Path in Claude projects dir**: `pathToProjectDir()` replaces both `/` and `\` with `-`

## Sessions Choreography

You are running inside Claude Session Manager. The babysitter watches all sessions and auto-retries crashes and stalls — but you can take control yourself using two tools: **self-alarm** and **delegation**.

### Приоритет задач — не спрашивай, действуй

Если все задачи нужны и вопрос только в порядке выполнения — **не спрашивай**. Выбери наиболее логичный порядок (критический баг → блокеры → параллельные задачи) и начинай.

Спрашивать о порядке имеет смысл только если одна задача **отменяет** другую. Если все нужны — порядок не меняет результат, только тратит время.

Если всё же нужно уточнение — ставь себе alarm на 5 минут:
```bash
curl -s -X POST "http://localhost:3000/api/sessions/YOUR_SESSION_ID/alarm" \
  -H "Content-Type: application/json" \
  -d '{"message": "Нет ответа на вопрос о приоритете. Выбери наиболее логичный порядок и продолжай.", "check_after_ms": 300000}'
```
Нет ответа через 5 минут → бабиситтер вернёт тебя с инструкцией действовать самостоятельно.

### When to split into a new session

If you notice a session starting to cover two separate projects or themes — delegate one immediately. Signs that it's time to split:

- The conversation touches **two different repos** (`~/project-a` and `~/project-b`)
- There are **parallel independent tasks** that don't need to wait for each other
- The thread is getting long and a new topic is starting that will generate its own 10+ messages

**How to split:** spin up a delegated sub-session with the full context it needs, then continue your current thread. Don't try to hold both in one session — context gets polluted and neither task gets clean focus.

```bash
curl -s -X POST "http://localhost:3000/api/sessions/start" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/abs/path/to/other-project",
    "message": "<full context the new session needs to start independently>",
    "reply_to_session_id": "YOUR_SESSION_ID",
    "delegation_task": "brief label"
  }'
```

Pass enough context in `message` that the new session can work independently — don't assume it has any shared memory with you.

### When to use what

| Situation | Tool |
|-----------|------|
| About to do something risky (deploy, migration, long build) and might crash | **Self-alarm** |
| Need work done in a different folder / with different permissions | **Delegation** |
| Two topics diverging in one session | **Delegation** — split immediately |
| Want to signal another already-running session | **Orchestrator enqueue** |

### Finding your session ID

If started via Session Manager (web UI or API) — your ID is in the `[Session Manager Context]` block at the top of your system prompt. Use it directly.

If running directly in a terminal:
```bash
# By project dir (fastest)
curl -s "http://localhost:3000/api/sessions/peers?path=$(pwd)" | jq '.peers[0].session_id'

# All active sessions (if you don't know your path)
curl -s "http://localhost:3000/api/sessions/peers" | jq '.peers[] | {session_id, project_path}'
```

**All session types are tracked** — Claude CLI, Codex TUI, Forge. If you appear in the Session Manager UI, you have a `session_id` and can use both tools below.

---

### Self-alarm — "if I die, resume me with this message"

Set before any risky operation. While the alarm is active, **babysitter skips normal crash/stall handling** for your session — the alarm owns recovery.

**Required use:**

- If your session is visible in Session Manager UI, treat it as alarm-capable.
- Before any long-running or failure-prone phase, either set a self-alarm or explicitly decide not to and know why.
- Long multi-step work without either arming an alarm or stating a concrete reason not to is a process failure.

**Set a self-alarm when all are true:**

- the task is likely to continue for more than roughly 10 minutes
- losing the current thread would slow recovery materially
- the next useful step after a crash is already known

Examples:

- multi-repo implementation
- deploy
- migration
- long debugging or regression pass
- delegated orchestration work

**Do not set a self-alarm when:**

- the session is about to end normally
- continuation would require fresh user input or approval
- the next step is still ambiguous

**Alarm message rule:**

The alarm message should always include:

- current repo or repos
- current step
- exact next action
- critical safety constraints

Template:

```text
Resume in <repo>. Current step: <what was being done>. Next: <exact next action>. Constraints: <important limits>.
```

Example:

```text
Resume in recruiting-agent / recruiting-ci-cd. Current step: stabilize recruiter query flow and regression docs. Next: inspect delegated findings, run targeted regression for vacancies/candidates/funnel/profile, and keep testing read-only. Constraints: do not send anything to candidates and do not perform irreversible actions.
```

```bash
# Arm — babysitter resumes you with this message if you go inactive for check_after_ms
curl -s -X POST "http://localhost:3000/api/sessions/YOUR_SESSION_ID/alarm" \
  -H "Content-Type: application/json" \
  -d '{"message": "Continue from step 3: run smoke tests, then deploy", "check_after_ms": 180000}'

# Disable babysitter entirely for this session (use when you're done / waiting for user)
curl -s -X DELETE "http://localhost:3000/api/sessions/YOUR_SESSION_ID/alarm"

# Re-enable babysitter (fully remove the disabled marker)
curl -s -X DELETE "http://localhost:3000/api/sessions/YOUR_SESSION_ID/alarm?clear=true"
```

Every babysitter message already contains this disable curl — just copy and run it.

Default timeout: 3 min. Default message: generic "continue from where you left off".

**Pattern:**
```bash
# 1. Arm
curl -s -X POST ".../alarm" -d '{"message": "retry the migration from step 2"}'
# 2. Do the risky thing
npm run migrate
# 3. Disarm on success
curl -s -X DELETE ".../alarm"
```

Cancel the self-alarm immediately after:

- the risky phase completed successfully
- the session is intentionally handing control back to the user
- the next continuation would require a different alarm message

---

### Delegation — "do this in another folder and report back"

Use when you need work done in a different project directory (different permissions, different repo, parallel work).

```bash
curl -s -X POST "http://localhost:3000/api/sessions/start" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/abs/path/to/other/project",
    "message": "Fix the auth bug in login.ts and deploy",
    "reply_to_session_id": "YOUR_SESSION_ID",
    "delegation_task": "fix auth bug",
    "agent": "claude"
  }'
```

The spawned session gets a `[Delegation Contract]` block with exact curl commands to report back. When done it calls:
```bash
# From inside the delegated session:
curl -s -X POST "http://localhost:3000/api/sessions/PARENT_SESSION_ID/reply" \
  -H "Content-Type: application/json" \
  -d '{"message": "DONE: fixed auth bug, committed to fix/auth-token"}'
# or: "FAILED: <reason>"
```

If the child crashes or forgets to report → babysitter auto-sends `FAILED:` to you after 3 reminders.

**Agent types:** `"claude"` (default), `"codex"`, `"forge"`.

---

### Signaling another session

```bash
# Fire-and-forget message to another session (returns immediately)
curl -s -X POST "http://localhost:3000/api/orchestrator" \
  -H "Content-Type: application/json" \
  -d '{"type":"resume","sessionId":"TARGET_SESSION_ID","message":"deploy done, run smoke tests","priority":"high"}'
# → {"taskId":"resume:TARGET_SESSION_ID","ok":true}
```

Use orchestrator (not `/reply`) for inter-session signals — `/reply` blocks until Claude finishes responding.

### Codex и другие TUI-агенты — как работать с делегированием

Codex (и другие TUI-агенты) **не получают `[Session Manager Context]` автоматически** — этот блок инжектируется только в Claude-сессии через `--append-system-prompt`. Поэтому:

- Codex не знает свой `session_id` автоматически
- Codex не умеет ставить себе alarm
- Babysitter не пингует Codex-сессии при зависании

**Но это не проблема для отчётности** — callback для Codex тот же самый механизм: просто HTTP POST наружу. Codex умеет делать curl, значит умеет отчитываться.

**Как передать Codex инструкции по делегированию:**

Скажи Codex явно в начале задачи:
```
Read /Users/vova/Documents/GitHub/claude-session-manager/CLAUDE.md
section "Sessions Choreography" → "Delegation contract".

If you need to delegate work to another session, use agent: "claude" (not "codex")
to ensure Claude Code is launched.

Your callback URL for reporting back: POST http://localhost:3000/api/sessions/PARENT_ID/reply
body: {"message": "DONE: <summary>"} or {"message": "FAILED: <reason>"}
```

**Как Codex находит свой session_id** (если нужен):
```bash
curl -s "http://localhost:3000/api/sessions/peers?path=$(pwd)" | jq '.peers[0].session_id'
```

**Почему `agent: "claude"` важно при делегировании из Codex:**
Codex → запускает Claude (не Codex) → Claude получает контекст автоматически, умеет alarm, умеет delegation contract. Цепочка Codex → Claude даёт полный набор инструментов дочерней сессии.

### Длинный ping-pong между сессиями (Codex ↔ Claude)

Когда нужно гонять большой план итерациями между агентами — используй паттерн **координатор + эстафета**.

#### Почему не прямой ping-pong

Прямой ping-pong (A запускает B, B запускает A, ...) хрупкий: если одна сессия падает — цепочка рвётся, и никто не знает где остановились. Вместо этого:

#### Паттерн: координатор держит план, воркеры делают итерации

```
Coordinator (Claude, долгоживущий)
  └── запускает Codex-воркер с задачей на итерацию
        └── Codex работает, отчитывается DONE/FAILED
  └── смотрит результат, запускает следующую итерацию
        └── Claude-воркер или снова Codex
  └── ... пока план не закрыт
```

**Координатор** — Claude-сессия с alarm. Он знает весь план и решает кто делает следующую итерацию.

**Воркер** — делает одну итерацию, отчитывается, умирает. Stateless.

#### Coordinator: что нужно сделать в начале

```bash
# 1. Вооружить alarm на весь процесс
curl -s -X POST "http://localhost:3000/api/sessions/YOUR_ID/alarm" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Продолжай план. Текущая итерация: [N]. Следующий воркер: Codex в /path/to/project. Контекст: [краткое резюме где остановились].",
    "check_after_ms": 600000
  }'

# 2. Запустить воркера
curl -s -X POST "http://localhost:3000/api/sessions/start" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/path/to/project",
    "message": "Iteration N: [конкретная задача]. When done, report back: DONE: <summary> or FAILED: <reason>",
    "reply_to_session_id": "YOUR_ID",
    "delegation_task": "iteration N: [краткое описание]",
    "agent": "claude"
  }'

# 3. Ждать reply от воркера (babysitter пинганёт если воркер молчит)
# 4. Получив DONE/FAILED — обновить alarm, запустить следующую итерацию
# 5. Когда план закрыт — снять alarm
curl -s -X DELETE "http://localhost:3000/api/sessions/YOUR_ID/alarm"
```

#### Что передавать воркеру в message

Воркер stateless — он должен получить в `message` всё что нужно:
- Что было сделано до него (контекст)
- Конкретная задача на эту итерацию
- Где лежит код / какой бранч
- Критические ограничения (не деплоить, не трогать прод, etc.)
- Callback инструкция уже инжектится автоматически через Delegation Contract

#### Что делать если что-то упало

- **Воркер упал** → babysitter авто-отправит `FAILED:` координатору → координатор получит сообщение и решит: retry или skip
- **Координатор упал** → его alarm сработает → babysitter резюмирует с контекстом где остановился
- **Оба упали** → смотришь последние сессии в UI, читаешь `last_message`, восстанавливаешь контекст вручную

#### Alarm-сообщение координатора — шаблон

```
Ты координатор большого плана. Текущий статус:
- Итерация: N из ~M
- Последнее что сделал воркер: [краткое]
- Следующая итерация: [что нужно сделать]
- Воркер: claude / codex, папка: /path/to/project
- Критические ограничения: [если есть]

Запусти следующего воркера и продолжай план.
```

### Git discipline (multi-session)

Any code that runs or deploys **must be committed** first. Not in git — doesn't exist from other sessions' perspective. Use branches for in-progress work — they're visible in `git branch`.
