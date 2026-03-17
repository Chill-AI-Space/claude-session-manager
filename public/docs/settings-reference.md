# Settings Reference

All settings are stored in `~/.config/claude-session-manager/settings.json`.
API: `GET /api/settings` (read all), `PUT /api/settings` (write `{ key: value }`).

---

## System Settings

Found on the **Settings** page (gear icon).

### auto_kill_terminal_on_reply
- **Default**: false
- **Section**: Terminal Integration
- Automatically close terminal sessions when replying from web UI.

### auto_retry_on_crash
- **Default**: true
- **Section**: Terminal Integration
- **Plugin**: session-babysitter
- **Keywords**: crash, retry, babysitter, incomplete, exit, hung, stuck, frozen, resume, auto
- Auto-retry when Claude crashes mid-tool-execution or exits unexpectedly (incomplete exit). Sends "continue" after 30s countdown.

### auto_continue_on_stall
- **Default**: true
- **Section**: Terminal Integration
- **Plugin**: session-babysitter
- **Keywords**: stall, continue, babysitter, stuck, idle, silent, nudge, auto
- Auto-continue when Claude goes silent for 5+ minutes. Uses Haiku AI to detect if waiting for user.

### new_session_from_reply
- **Default**: true
- **Section**: Terminal Integration
- **Plugin**: new-session-from-reply
- Show a toggle in the reply area to start a new session instead of replying.

### notify_sound
- **Default**: (not set)
- **Section**: Notifications
- **Keywords**: sound, notification, alert, beep, audio
- Play a two-tone beep when Claude finishes.

### notify_browser
- **Default**: (not set)
- **Section**: Notifications
- **Keywords**: notification, browser, popup, alert, desktop
- Show browser notification when Claude finishes. Requires browser permission.

### notify_tab_badge
- **Default**: (not set)
- **Section**: Notifications
- **Keywords**: notification, tab, badge, title, waiting
- Prepend "(N) Claude is waiting" to the page title.

### vector_search_top_k
- **Default**: 20
- **Section**: Deep Search
- How many sessions vector search pre-filters before Gemini ranking.

### browse_start_path
- **Default**: (empty — home directory)
- **Section**: Folder Browser
- Starting path for the folder tree in "Start session".

### font_size_scale
- **Default**: 100 (%)
- **Section**: Appearance
- **Keywords**: font, size, scale, zoom, text, appearance, theme
- Font size scaling (80%–120%). Stored in browser localStorage, not settings.json.

### theme
- **Default**: dark
- **Section**: Appearance
- **Keywords**: theme, dark, light, mode, appearance, color
- Color theme (dark/light). Toggle via the sun/moon button. Stored in browser localStorage.

---

## Plugin Settings

Found on the **Store** page (package icon) → click a plugin → settings panel.

### compress-on-input
- **Plugin**: compress-on-input
- **Config file**: `~/.config/compress-on-input/config.json`
- **Settings**: imageOcr, jsonCollapse, textCompressionThreshold, ocrEngine, verbose
- Managed via `/api/context-trash` API, not settings.json.

### relay_enabled
- **Default**: false
- **Plugin**: remote-relay
- Enable WebSocket connection to relay server for remote access.

### relay_node_id
- **Default**: (auto-generated)
- **Plugin**: remote-relay
- Unique Node ID for remote access. Share with whoever needs to send commands.

### relay_server_url
- **Default**: wss://csm-relay.chillai.workers.dev
- **Plugin**: remote-relay
- WebSocket relay server URL.

### remote_nodes
- **Default**: [] (JSON array)
- **Plugin**: remote-nodes
- Registry of remote Session Manager instances (Tailscale + Relay addresses).

### summary_model
- **Default**: gpt-4o-mini
- **Plugin**: summary-ai
- Model for generating full session summaries.

### summary_incremental_model
- **Default**: gemini-2.5-flash
- **Plugin**: summary-ai
- Model for incremental summaries (updated as session progresses).

### openai_api_key
- **Default**: (empty)
- **Plugin**: summary-ai
- OpenAI API key for summary generation.

### anthropic_api_key
- **Default**: (empty)
- **Plugin**: summary-ai
- Anthropic API key for summary generation.

### google_ai_api_key
- **Default**: (empty)
- **Plugin**: summary-ai
- Google AI (Gemini) API key for summary generation.

### dangerously_skip_permissions
- **Default**: false
- **Plugin**: permission-bridge
- Pass `--dangerously-skip-permissions` when resuming from web UI.

### max_turns
- **Default**: 80
- **Plugin**: permission-bridge
- Max tool-use cycles per single web reply.

### effort_level
- **Default**: high
- **Plugin**: permission-bridge
- Claude's thinking effort level: high, medium, or low.

### worker_heartbeat_timeout_ms
- **Default**: 300000
- **Plugin**: workers
- How long to wait before marking a worker as offline (ms).

### worker_fallback_enabled
- **Default**: true
- **Plugin**: workers
- Try to complete tasks via Claude API when worker goes offline.

### worker_fallback_model
- **Default**: claude-sonnet-4-5-20250514
- **Plugin**: workers
- Model for AI fallback when worker is offline.

### worker_fallback_use_vertex
- **Default**: false
- **Plugin**: workers
- Use Vertex AI instead of direct Anthropic API for fallback.

### worker_fallback_vertex_project
- **Default**: (empty)
- **Plugin**: workers
- Google Cloud project ID for Vertex AI.

### worker_fallback_vertex_region
- **Default**: us-east5
- **Plugin**: workers
- Vertex AI region.

### worker_notify_smtp_host
- **Default**: (empty)
- **Plugin**: workers
- SMTP server hostname for email notifications.

### worker_notify_smtp_port
- **Default**: 587
- **Plugin**: workers
- SMTP server port.

### worker_notify_smtp_user
- **Default**: (empty)
- **Plugin**: workers
- SMTP username.

### worker_notify_smtp_pass
- **Default**: (empty)
- **Plugin**: workers
- SMTP password (stored locally).

### worker_notify_from
- **Default**: (empty)
- **Plugin**: workers
- Email sender address.

### worker_notify_to
- **Default**: (empty)
- **Plugin**: workers
- Default email recipient.

### worker_notify_webhook_url
- **Default**: (empty)
- **Plugin**: workers
- POST JSON payloads on worker events (offline, fallback, task completed).

### session-babysitter

Monitors sessions for crashes, stalls, and incomplete exits. Configurable in Store → Session Babysitter.

### orchestrator_max_concurrent
- **Default**: 3
- **Plugin**: session-babysitter
- Max simultaneous Claude processes managed by the orchestrator task queue.

### orchestrator_crash_retry_delay_ms
- **Default**: 30000
- **Plugin**: session-babysitter
- Delay before auto-retry after crash (ms).

### orchestrator_stall_continue_delay_ms
- **Default**: 10000
- **Plugin**: session-babysitter
- Delay before auto-continue on stall (ms).

### orchestrator_max_retries
- **Default**: 3
- **Plugin**: session-babysitter
- Max crash/incomplete-exit retries per session before marking as failed.

---

## Session Babysitter — Detection Modes

The Session Babysitter plugin (Store → Session Babysitter) provides four detection modes:

| Mode | Trigger | Condition | Action |
|------|---------|-----------|--------|
| **Crash** | `last_message_role = tool_result` | Process dead, JSONL changed | Auto-retry with context prompt |
| **Incomplete exit** | `last_message_role = assistant`, `has_result = 0` | Process dead, no result event | Resume (checks if Claude was asking a question first) |
| **Stall** | `last_message_role = assistant`, silent >5min | Process alive but idle | Haiku checks intent → nudge or skip |
| **Permission loop** | Repeated permission errors in JSONL | 2+ permission errors in last 30 lines | Escalate to terminal with `--dangerously-skip-permissions` |

**Key concept: `has_result`** — When Claude exits normally, it writes a `type: "result"` event to JSONL. If this event is missing (`has_result = 0`), the process exited abnormally. This distinguishes "waiting for user reply" from "died mid-task".

**UI indicators** (session detail page):
- Orange banner: "Crashed mid-execution" with auto-retry countdown (30s)
- Amber banner: "Process exited after last response" with auto-resume countdown (45s)
- Both show Cancel / Retry now buttons

---

## Debug Settings

### debug_mode
- **Default**: false
- Enable debug logging.

### debug_log_endpoint
- **Default**: (empty)
- Optional endpoint to send debug logs to.
