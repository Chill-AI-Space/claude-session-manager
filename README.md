# Claude Session Manager

A localhost web UI for browsing, searching, and managing Claude Code sessions. Think email client for your Claude conversations — two-panel layout with session list on the left, full conversation on the right.

## What it does

- **Browse all sessions** from `~/.claude/projects/` grouped by project
- **Read conversations** with full markdown rendering, syntax highlighting, collapsible tool calls and thinking blocks
- **Reply to sessions** from the browser — streams Claude's response in real-time via SSE
- **Open in Terminal** — one click to resume any session in Terminal.app/iTerm2
- **Live status** — green dot on sessions that are currently running in a terminal
- **AI-generated titles** — Claude automatically summarizes each session
- **Search & filter** — by project, text query, sort by modified/created/tokens
- **Deep search** — semantic search via Gemini API (optional)
- **Settings** — auto-kill terminal, dangerously skip permissions

## Setup

### 1. Install

```bash
git clone https://github.com/kobzevvv/claude-session-manager
cd claude-session-manager
npm install
```

### 2. API keys

Create `.env.local` in the project root:

```bash
# .env.local

# Enables "Deep search with Gemini" — semantic search across all sessions
# Get a free key at https://aistudio.google.com/apikey
GEMINI_API_KEY=your_key_here
```

Without `GEMINI_API_KEY` everything works except deep search.

### 3. Build

```bash
npm run build
```

> **Note for Claude Code agents**: always run `npm run build` after code changes, then restart with `npm run start`. Production mode uses ~70 MB RAM vs ~700 MB in dev mode.

## Launch

### Option A — terminal alias (on-demand)

Add to `~/.zshrc`:

```zsh
sessions() {
  if ! lsof -ti:3000 >/dev/null 2>&1; then
    echo "Starting Claude Sessions..."
    /bin/zsh /path/to/claude-session-manager/scripts/start.sh >> /tmp/claude-sessions.log 2>&1 &
    sleep 2
  fi
  open http://localhost:3000/claude-sessions
}
```

Then type `sessions` in any terminal — starts the server if not running, opens the browser.

### Option B — always running in background (launchd, macOS)

```bash
# Enable: starts now + auto-starts on every login
launchctl load ~/Library/LaunchAgents/com.vova.claude-sessions.plist

# Disable
launchctl unload ~/Library/LaunchAgents/com.vova.claude-sessions.plist

# Logs
tail -f /tmp/claude-sessions.log
```

The plist is at `~/Library/LaunchAgents/com.vova.claude-sessions.plist` — update the path there if you move the project.

### Manual

```bash
npm run start   # production (~70 MB RAM)
npm run dev     # dev with hot reload (~700 MB RAM)
```

Open [http://localhost:3000/claude-sessions](http://localhost:3000/claude-sessions)

## Architecture

```
~/.claude/projects/**/*.jsonl  ←  source of truth (read-only)
         ↓ batched scan (non-blocking)
    SQLite cache (data/sessions.db)  ←  metadata + user customizations
         ↓ API
    Next.js App Router  →  React UI (localhost:3000)
         ↓ reply
    claude --resume <id> -p "..." --output-format stream-json
```

- **JSONL files** are never modified — SQLite caches metadata for fast listing
- **Incremental scan** checks file mtime only, skips unchanged sessions
- **Batched scan** yields to event loop every 30 files — UI stays responsive during scan
- **Replies** spawn a `claude` subprocess and stream output as SSE events
- **Process detection** uses `ps` + `lsof` to identify active sessions

## Stack

- Next.js 16 (App Router, Turbopack)
- TypeScript
- SQLite via better-sqlite3
- Tailwind CSS + shadcn/ui
- react-markdown + rehype-highlight + remark-gfm

## Project structure

```
src/
├── app/
│   ├── claude-sessions/
│   │   ├── layout.tsx              # Two-panel layout with sidebar
│   │   ├── [sessionId]/page.tsx    # Session detail + reply
│   │   └── settings/page.tsx       # Settings page
│   └── api/
│       ├── sessions/               # List, scan, detail, reply, kill, open, titles
│       ├── projects/               # Project list
│       ├── settings/               # Settings CRUD
│       ├── status/                 # Running processes
│       ├── events/                 # SSE real-time updates
│       ├── browse/                 # Folder browser for new sessions
│       └── launch/                 # Launch new claude session
├── lib/
│   ├── db.ts                       # SQLite connection + schema
│   ├── scanner.ts                  # JSONL → DB metadata extraction
│   ├── session-reader.ts           # JSONL → parsed messages
│   ├── process-detector.ts         # Detect & kill active sessions
│   ├── title-generator.ts          # AI title generation via Claude
│   ├── embeddings.ts               # Vector embeddings for Gemini search
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

## Settings

Available at **Settings** (gear icon in sidebar):

| Setting | What it does |
|---------|-------------|
| **Auto-kill terminal on reply** | Kills running terminal session before sending a web reply, preventing conversation divergence |
| **Dangerously skip permissions** | Passes `--dangerously-skip-permissions` to Claude CLI — skips all tool confirmation prompts |

## Requirements

- Node.js 18+
- Claude Code CLI (`claude`) installed and in PATH
- macOS (process detection and "Open in Terminal" use macOS-specific APIs)
