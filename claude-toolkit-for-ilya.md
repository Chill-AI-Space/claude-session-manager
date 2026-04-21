# Claude Code Toolkit — Setup Guide for Ilya

Three open source tools, all running locally. Each link points to a CLAUDE.md — feed it to Claude Code, it will read the instructions and set everything up.

Works with both **Claude Code** and **Cursor** (Cursor reads the same CLAUDE.md files).

---

## Your main concern: context collapse

When a session gets too long, Claude compresses (compacts) the conversation — and can lose critical context. This is what causes the "it forgot what we were doing" problem. Two tools below directly address this:

1. **Session Manager** writes realtime `.md` snapshots of every active session. If context collapses — the snapshot has the full state, and the session can be resumed from it
2. **Compress On Input** prevents bloat from ever building up — screenshots, fat JSON, DOM dumps get compressed before entering context, so you hit the limit much later

---

## 1. Session Manager — Web UI for Claude Code sessions

**Link:** https://github.com/Chill-AI-Space/claude-session-manager/blob/main/CLAUDE.md

Runs entirely locally, nothing exposed to the internet.

### Key features

- **Search** across all sessions — full-text, by prompts and responses
- **Continue chat** in a new session with preserved context — no lost threads when switching
- **Open session in terminal** — button launches Claude Code with that session
- **Focus on already open terminal** — target button 🎯, switches to the window if session is already running
- **Learnings and Summary** generated automatically per session — prompts are customizable in Settings
- **Realtime session snapshots** — continuously writes `.md` snapshots of active sessions. If Claude's context collapses (compaction, crash, timeout), the snapshot preserves the full state so the session can be resumed without losing context

### Babysitter (optional)

Automatic session choreographer — analyzes why a session stopped and decides whether to continue:
- Catches crashes and auto-retries
- Complex tasks sometimes complete on 2nd-3rd attempt
- Detects "stalled" sessions and pings them

Toggled from the menu bar icon (quasar spiral). If something goes wrong — Vova gets a bug report automatically.

> **Note:** If you use Cursor's auto-continue or any similar orchestration, keep Babysitter off to avoid conflicts.

---

## 2. Compress On Input — MCP proxy for preventing context bloat

**Link:** https://github.com/Chill-AI-Space/compress-on-input/blob/main/CLAUDE.md

**This directly helps with your context collapse concern.** Compresses bloated tool responses before they enter Claude's context window:
- Screenshots → OCR text instead of raw pixels
- Large JSON → compressed to essentials
- DOM dumps → cleaned up

Less bloat = more room for actual conversation = context collapse happens much later (or not at all). One week of logs — zero failures. Install and forget.

---

## 3. Gated Knowledge — search and access data from Google Drive, Sheets, Gmail

**Link:** https://github.com/Zerocreds-com/gated-docs/blob/main/CLAUDE.md

For your own Claude Code sessions — works out of the box, no setup needed. You can ask Claude:
- Session summaries and key takeaways
- What was decided, what was learned
- Detailed data per session

Also connects to Google Drive, Sheets, Gmail, BigQuery — useful if you need Claude to pull data from docs or spreadsheets for content work.

---

## Installation

All three install the same way:

```bash
git clone <repo-url>
cd <repo-name>
npm install
```

Clone, open in Claude Code — it will read CLAUDE.md and handle setup.

For Cursor: clone the repo, the CLAUDE.md file will be picked up automatically.

---

## P.S. from Vova

Yesterday I completely rewrote the Session Manager architecture from scratch. Realized one key insight — the role of `.md` files. Rewrote all snapshots, summaries, all internal data handling into native `.md` format. This sped up the app, all lookups, and search by **16x** on average.
