# Claude Session Manager

A localhost web UI for browsing, searching, and managing Claude Code sessions. Think email client for your Claude conversations — two-panel layout with session list on the left, full conversation on the right.

Works on **macOS, Linux, and Windows**.

## What it does

- **Browse all sessions** from `~/.claude/projects/` grouped by project
- **Read conversations** with full markdown rendering, syntax highlighting, collapsible tool calls and thinking blocks
- **Reply to sessions** from the browser — streams Claude's response in real-time via SSE
- **Open in Terminal** — one click to resume any session in Terminal.app/iTerm2 (macOS)
- **Live status** — green dot on sessions that are currently running in a terminal
- **AI-generated titles** — Claude automatically summarizes each session
- **Search & filter** — by project, text query, sort by modified/created/tokens
- **Deep search** — semantic search via Gemini API (optional)
- **Analytics** — token usage, cost estimates, daily activity charts
- **Action log** — debugger for auto-retry, crashes, stalls
- **Notifications** — browser + sound alerts when Claude finishes and needs your reply
- **Auto-retry** — detects mid-execution crashes and auto-sends "continue"

## Quick start

```bash
git clone https://github.com/kobzevvv/claude-session-manager.git
cd claude-session-manager
npm install
npm run build
npm start
```

Open [http://localhost:3000/claude-sessions](http://localhost:3000/claude-sessions)

### Requirements

- **Node.js 18+** (20+ recommended)
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** CLI installed and in PATH

### Optional: Gemini deep search

Create `.env.local` in the project root:

```bash
# Enables "Deep search with Gemini" — semantic search across all sessions
# Get a free key at https://aistudio.google.com/apikey
GEMINI_API_KEY=your_key_here
```

Without `GEMINI_API_KEY` everything works except deep search.

## Platform notes

| Feature | macOS | Linux | Windows |
|---------|-------|-------|---------|
| Browse & read sessions | Yes | Yes | Yes |
| Reply from browser | Yes | Yes | Yes |
| Live session detection | Yes | Yes | Partial |
| Open in terminal (one-click) | Yes | No | No |
| Focus terminal tab | Yes | No | No |

On Windows, Claude Code stores sessions in `%USERPROFILE%\.claude\projects\`. The session manager auto-detects the correct paths.

## Launch options

### Just run it

```bash
npm start              # production (~70 MB RAM)
npm run dev            # dev with hot reload (~700 MB RAM)
```

### Shell alias (macOS/Linux)

Add to `~/.zshrc` or `~/.bashrc`:

```bash
sessions() {
  if ! lsof -ti:3000 >/dev/null 2>&1; then
    echo "Starting Claude Sessions..."
    cd /path/to/claude-session-manager && nohup npm start > /tmp/sessions-server.log 2>&1 &
    sleep 2
  fi
  open http://localhost:3000/claude-sessions  # macOS
  # xdg-open http://localhost:3000/claude-sessions  # Linux
}
```

### Menu bar app + auto-start on login (macOS)

Run as a native menu bar icon that starts the server automatically on login:

```bash
# 1. Build the app
npm run build

# 2. Create the launchd plist
cat > ~/Library/LaunchAgents/com.vova.claude-sessions.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.vova.claude-sessions</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/node</string>
        <string>scripts/tray.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/claude-session-manager</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/path/to/node/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>/Users/yourname</string>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/yourname/Library/Logs/claude-session-manager.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/yourname/Library/Logs/claude-session-manager-error.log</string>
</dict>
</plist>
EOF

# 3. Load it
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.vova.claude-sessions.plist
```

Replace `/path/to/node` with `which node` output, and `/path/to/claude-session-manager` with where you cloned the repo.

**Menu bar icon**: A white Claude icon appears in your menu bar. Click it to open the app or quit.

**Manage the service:**

```bash
# Stop
launchctl bootout gui/$(id -u)/com.vova.claude-sessions

# Restart
launchctl kickstart -k gui/$(id -u)/com.vova.claude-sessions

# Status
launchctl list | grep claude-sessions

# Logs
tail -f ~/Library/Logs/claude-session-manager.log
```

## Terminal vs Web Replies

### Terminal (interactive mode)

```bash
claude                    # long-lived process, unlimited turns
```

Claude runs interactively — unlimited tool-use cycles, can ask questions, keeps working until the task is done. You approve permissions inline.

### Web UI (non-interactive mode)

```bash
claude -p "your message" --resume <session-id> --max-turns 80
```

Each web reply spawns a **one-shot** `claude -p` process. Claude receives your message, works for up to `--max-turns` tool-use cycles, responds, and the process exits.

| | Terminal | Web UI |
|---|---|---|
| **Turns** | Unlimited | Limited by `--max-turns` (default 80) |
| **Permissions** | Interactive approval | Needs `--dangerously-skip-permissions` |
| **Connection** | Direct stdin/stdout | SSE stream over HTTP |
| **When Claude stops** | Just type and continue | Send another web reply |

### Why web sessions might stop early

1. **Max turns reached** — increase in Settings
2. **Claude chose to stop** — send "continue" as a follow-up
3. **Permission required** — enable Skip Permissions in Settings
4. **Connection dropped** — the UI auto-detects and recovers (45s timeout)

### Recommendations

- **Complex multi-step tasks** — use the terminal
- **Quick follow-ups** — web UI works great
- **Autonomous web work** — enable Skip Permissions + set Max turns to 100-200

## Session Self-Alarm

Sessions can arm themselves with a wake-up alarm — useful for long-running or risky tasks where a crash or stall would lose context.

```bash
# Set alarm: if I'm inactive for 3 min, resume me with this message
curl -s -X POST "http://localhost:3000/api/sessions/SESSION_ID/alarm" \
  -H "Content-Type: application/json" \
  -d '{"message": "Continue with the deploy — run smoke tests next", "check_after_ms": 180000}'

# Cancel alarm
curl -s -X DELETE "http://localhost:3000/api/sessions/SESSION_ID/alarm"
```

**How it works:**
- While alarm is active → babysitter skips crash/stall auto-retry for that session
- When time expires AND process is dead → babysitter resumes session with the alarm message
- If process is still alive when time expires → alarm stays armed, fires when it eventually dies

**Sessions get their own alarm URL automatically** via the `[Session Manager Context]` block injected into every session's system prompt — no need to look up the session ID manually.

The active alarm is visible in the session detail UI (⏰ indicator with remaining time + cancel button).

## Architecture

```
~/.claude/projects/**/*.jsonl  ←  source of truth (read-only)
         ↓ batched scan (non-blocking)
    SQLite cache (data/sessions.db)  ←  metadata + user customizations
         ↓ API
    Next.js App Router  →  React UI (localhost:3000)
         ↓ reply
    claude --resume <id> -p "..." --output-format stream-json --max-turns 80
```

- **JSONL files** are never modified — SQLite caches metadata for fast listing
- **Incremental scan** checks file mtime only, skips unchanged sessions
- **Batched scan** yields to event loop every 30 files — stays responsive during scan
- **Replies** spawn a `claude` subprocess and stream output as SSE events
- **Process detection** uses `ps` + `lsof` to identify active sessions

## Stack

- Next.js 16 (App Router, Turbopack)
- TypeScript, React 19
- SQLite via better-sqlite3
- Tailwind CSS 4 + shadcn/ui
- react-markdown + rehype-highlight + remark-gfm

## Settings

Available at **Settings** (gear icon in sidebar):

| Setting | Default | Description |
|---------|---------|-------------|
| **Max turns per reply** | 80 | Tool-use cycles per web reply. Set 100-200 for complex tasks |
| **Skip permissions** | off | Pass `--dangerously-skip-permissions` to Claude |
| **Auto-kill terminal** | off | Kill terminal session before sending a web reply |
| **Auto-retry on crash** | on | Auto-send "continue" after 30s on crash |
| **Auto-continue on stall** | off | Auto-send "continue" when idle 5+ min |

## Project structure

```
src/
├── app/
│   ├── claude-sessions/
│   │   ├── layout.tsx              # Two-panel layout with sidebar
│   │   ├── [sessionId]/page.tsx    # Session detail + reply
│   │   ├── settings/page.tsx       # Settings page
│   │   ├── analytics/page.tsx      # Usage analytics
│   │   ├── actions/page.tsx        # Action log debugger
│   │   └── help/page.tsx           # Help & troubleshooting
│   └── api/
│       ├── sessions/               # List, scan, detail, reply, kill, search
│       ├── analytics/              # Token usage & cost stats
│       ├── actions-log/            # Action log API
│       ├── settings/               # Settings CRUD
│       ├── browse/                 # Folder browser
│       └── launch/                 # Launch new session
├── lib/
│   ├── db.ts                       # SQLite connection + schema
│   ├── scanner.ts                  # JSONL → DB metadata extraction
│   ├── session-reader.ts           # JSONL → parsed messages
│   ├── process-detector.ts         # Detect & kill active sessions
│   ├── title-generator.ts          # AI title generation via Claude
│   ├── activity-status.ts          # Session status classification
│   ├── utils.ts                    # Cross-platform path helpers
│   ├── embeddings.ts               # Vector embeddings for search
│   └── types.ts                    # Shared types
└── components/
    ├── SessionList.tsx             # Sidebar session list
    ├── SessionListItem.tsx         # Individual session row
    ├── SessionSearch.tsx           # Search + Gemini deep search
    ├── MessageBubble.tsx           # User/assistant message
    ├── ReplyInput.tsx              # Reply with message queue
    ├── FolderBrowserDialog.tsx     # Browse folders to start session
    └── MarkdownContent.tsx         # Markdown renderer
```

## Troubleshooting

**Port 3000 in use:**
```bash
# macOS/Linux
lsof -ti:3000 | xargs kill -9

# Windows
netstat -ano | findstr :3000
taskkill /PID <pid> /F
```

**Sessions not showing up:**
- Make sure Claude Code CLI is installed and you've used it at least once
- Sessions are stored in `~/.claude/projects/` — check that directory exists
- Click the refresh button or wait for auto-scan

**Build fails:**
```bash
rm -rf .next
npm run build
```
