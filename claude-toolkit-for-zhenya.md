# Claude Code Toolkit — Setup Guide

Three open source tools, all running locally. Each link points to a CLAUDE.md — feed it to Claude Code and it will read the instructions and set everything up.

---

## 1. Session Manager — Web UI for Claude Code sessions

**Link:** https://github.com/Chill-AI-Space/claude-session-manager/blob/main/CLAUDE.md

Runs entirely locally, nothing exposed to the internet — secure by architecture.

### Key features

- **Search** across all sessions — full-text, by prompts and responses
- **Continue chat** in a new session with preserved context — no lost threads when switching
- **Open session in terminal** — button launches Claude Code with that session
- **Focus on already open terminal** — target button, if the session is already running, switches the window to it
- **Learnings and Summary** generated automatically per session — prompts are customizable in Settings
- **Menu bar icon** (quasar spiral, next to Zoom/Telegram) — toggles Babysitter on/off
- **Realtime session snapshots** — Session Manager continuously writes `.md` snapshots of active sessions. If Claude's context collapses mid-conversation (compaction, crash, timeout), the snapshot preserves the full state so the session can be resumed without losing context

### Babysitter

Automatic session choreographer. Analyzes why a session stopped and decides whether to continue it:

- Catches crashes and auto-retries
- Complex tasks sometimes complete on 2nd-3rd attempt — you come back and the result is ready
- Detects permission errors and escalates
- Detects "stalled" sessions (Claude went silent) and pings them

Toggled from the menu bar icon. If something goes wrong — Vova gets a bug report automatically.

> **Heads up:** If you already run your own orchestration / auto-continue logic on top of Claude Code, Babysitter may conflict with it (both trying to resume the same session). Start with Babysitter off, test on a few sessions, then decide.

---

## 2. Gated Knowledge — access data from Google Drive, Sheets, Gmail, BigQuery

**Link:** https://github.com/Zerocreds-com/gated-docs/blob/main/CLAUDE.md

### Your own Claude Code sessions — works out of the box

Gated Knowledge sees local Claude Code sessions without any extra setup. You can immediately ask:
- Session summaries
- Key takeaways, conclusions, learnings
- Detailed data per session

### Sharing sessions with your team via Google Drive

This is your main use case. Setup:
1. Choose folders you want to share sessions from
2. Point them in Gated Knowledge config
3. Authorize — the process is slightly tricky, will show a red indicator. This is normal and safe (you can ask Claude to confirm)
4. After setup — Claude from any session can search and analyze sessions across your entire team

---

## 3. Compress On Input — MCP proxy for compressing bloated tool responses

**Link:** https://github.com/Chill-AI-Space/compress-on-input/blob/main/CLAUDE.md

Compresses bloated tool responses before they enter Claude's context:
- Screenshots (OCR instead of raw pixels)
- Large JSON payloads
- DOM dumps

One week of logs — zero failures, no negative impact. Install and forget.

---

## Installation

All three install the same way:

```bash
git clone <repo-url>
cd <repo-name>
npm install
```

Clone, open in Claude Code — it will read CLAUDE.md and handle setup.

---

## P.S. from Vova

Yesterday I completely rewrote the Session Manager architecture from scratch. Realized one key insight — the role of `.md` files. Rewrote all snapshots, summaries, all internal data handling into native `.md` format. This sped up the app, all lookups, and search by **16x** on average.
