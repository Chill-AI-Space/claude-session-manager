# Claude Session Manager

A localhost web UI for browsing, searching, and managing Claude Code sessions. Think email client for your Claude conversations — two-panel layout with session list on the left, full conversation on the right.

## What it does

- **Browse all sessions** from `~/.claude/projects/` grouped by project
- **Read conversations** with full markdown rendering, syntax highlighting, collapsible tool calls and thinking blocks
- **Reply to sessions** from the browser — streams Claude's response in real-time via SSE
- **Open in Terminal** — one click to resume any session in Terminal.app/iTerm2
- **Live status** — green dot on sessions that are currently running in a terminal
- **Search & filter** — by project, text query, sort by modified/created/tokens
- **Settings** — auto-kill terminal sessions when replying from web (prevents conversation divergence)

## Architecture

```
~/.claude/projects/**/*.jsonl  ←  source of truth (read-only)
         ↓ scan
    SQLite cache (data/sessions.db)  ←  metadata + user customizations
         ↓ API
    Next.js App Router  →  React UI (localhost:3000)
         ↓ reply
    claude --resume <id> -p "..." --output-format stream-json
```

- **JSONL files** are never modified — SQLite caches metadata for fast listing
- **Incremental scan** checks file mtime (~200ms) vs full scan (~7s for 380+ sessions)
- **Replies** spawn a `claude` subprocess and stream output as SSE events
- **Process detection** uses `ps` + `lsof` to identify active sessions

## Stack

- Next.js 16 (App Router, Turbopack)
- TypeScript
- SQLite via better-sqlite3
- Tailwind CSS + shadcn/ui
- react-markdown + rehype-highlight + remark-gfm

## Getting started

```bash
npm install
npm run dev
# Open http://localhost:3000
```

The first load triggers an incremental scan of `~/.claude/projects/`. Sessions appear in the sidebar grouped by project.

## Project structure

```
src/
├── app/
│   ├── sessions/
│   │   ├── layout.tsx              # Two-panel layout with sidebar
│   │   ├── [sessionId]/page.tsx    # Session detail + reply
│   │   └── settings/page.tsx       # Settings page
│   └── api/
│       ├── sessions/               # List, scan, detail, reply, kill, open
│       ├── projects/               # Project list
│       ├── settings/               # Settings CRUD
│       ├── status/                 # Running processes
│       └── events/                 # SSE real-time updates
├── lib/
│   ├── db.ts                       # SQLite connection + schema
│   ├── scanner.ts                  # JSONL → DB metadata extraction
│   ├── session-reader.ts           # JSONL → parsed messages
│   ├── process-detector.ts         # Detect & kill active sessions
│   └── types.ts                    # Shared types
└── components/
    ├── MessageView.tsx             # Conversation display
    ├── MessageBubble.tsx           # User/assistant message
    ├── ToolUseBlock.tsx            # Collapsible tool call
    ├── ThinkingBlock.tsx           # Collapsible thinking
    ├── ReplyInput.tsx              # Reply with message queue
    ├── SessionList.tsx             # Sidebar session list
    └── StatusBadge.tsx             # Active/inactive indicator
```

## Requirements

- Node.js 18+
- Claude Code CLI (`claude`) installed and available in PATH
- macOS (process detection and "Open in Terminal" use platform-specific APIs)
