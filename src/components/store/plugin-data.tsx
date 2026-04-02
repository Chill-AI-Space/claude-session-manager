import {
  Link2,
  BookOpen, Minimize2, Shield, Chrome, Fingerprint, Lock,
  Plug, Camera, Construction, MessageSquare, Mail, Search,
  Sparkles, Terminal, ShieldCheck, HeartPulse,
  Wifi, Server, Brain, Cog,
} from "lucide-react";
import type { PluginData } from "./PluginCard";
import {
  BabysitterSettings,
  ContextTrashSettings,
  NewSessionFromReplySettings,
  RemoteRelaySettings,
  RemoteNodesSettings,
  SummaryAiSettings,
  WorkersSettings,
  PermissionsSettings,
} from "@/components/settings";

export const PLUGINS: PluginData[] = [
  // ── Installed ──
  {
    id: "compress-on-input",
    name: "compress-on-input",
    description: "MCP proxy that compresses bloated tool results before they enter Claude's context window.",
    longDescription:
      "Intercepts oversized tool results (OCR screenshots, raw DOM dumps, large API responses) and compresses them on the fly. Keeps context clean and focused without losing important information.",
    category: "Context management",
    tags: ["mcp", "gemini"],
    icon: <Minimize2 className="h-5 w-5" />,
    status: "installed",
    standalone: true,
    repo: "Chill-AI-Space/compress-on-input",
    links: [
      { label: "GitHub", href: "https://github.com/Chill-AI-Space/compress-on-input" },
    ],
    settingsComponent: ContextTrashSettings as React.ComponentType<any>,
  },
  {
    id: "instant-publish",
    name: "instant-publish",
    description: "Publish self-contained HTML pages as password-protected shareable links via chillai.space.",
    longDescription:
      "One-command deployment of HTML files to chillai.space with auto-generated passwords. Supports custom slugs, republishing with preserved passwords, and TTL management.",
    category: "Publishing",
    tags: [],
    icon: <Link2 className="h-5 w-5" />,
    status: "installed",
    standalone: true,
    repo: "Chill-AI-Space/instant-publish",
    links: [
      { label: "GitHub", href: "https://github.com/Chill-AI-Space/instant-publish" },
      { label: "Portal", href: "https://chillai.space" },
    ],
  },
  {
    id: "remote-relay",
    name: "Remote Relay",
    description: "Control sessions from anywhere via WebSocket relay server.",
    longDescription:
      "Opens a persistent WebSocket connection to a relay server. Remote callers can start, resume, and stop sessions using your unique Node ID. Works from any machine, GCP VM, or HTTP client.",
    category: "Networking",
    tags: ["built-in", "websocket"],
    icon: <Wifi className="h-5 w-5" />,
    status: "installed",
    settingsComponent: RemoteRelaySettings as React.ComponentType<any>,
    settingsKeys: ["relay_enabled", "relay_node_id", "relay_server_url"],
  },
  {
    id: "remote-nodes",
    name: "Remote Nodes",
    description: "Register and proxy commands to remote Session Manager instances.",
    longDescription:
      "Register other machines running Session Manager. Commands are sent via Tailscale (direct P2P) or Cloudflare Relay (via internet), with automatic fallback between transport methods.",
    category: "Networking",
    tags: ["built-in", "tailscale"],
    icon: <Server className="h-5 w-5" />,
    status: "installed",
    settingsComponent: RemoteNodesSettings as React.ComponentType<any>,
    settingsKeys: ["remote_nodes", "default_compute_node"],
  },
  {
    id: "summary-ai",
    name: "Summary AI",
    description: "AI models & session summaries via OpenAI, Anthropic, Google, or Z.AI (GLM).",
    longDescription:
      "Generates session summaries using direct API calls (no CLI sessions spawned). Long transcripts are automatically split into chunks with map/reduce. Supports incremental summaries that update as the session progresses.",
    category: "AI",
    tags: ["built-in", "api"],
    icon: <Brain className="h-5 w-5" />,
    status: "installed",
    settingsComponent: SummaryAiSettings as React.ComponentType<any>,
    settingsKeys: ["summary_model", "summary_incremental_model", "learnings_model", "auto_generate_summary", "auto_generate_learnings", "openai_api_key", "anthropic_api_key", "google_ai_api_key", "zai_api_key"],
  },
  {
    id: "workers",
    name: "External Workers",
    description: "Register external workers for task processing with AI fallback and email notifications.",
    longDescription:
      "External workers register via API, send heartbeats, and process tasks. If a worker goes offline, the fallback chain triggers: AI completion attempt → email notification. Supports SMTP and webhook notifications.",
    category: "Orchestration",
    tags: ["built-in", "api"],
    icon: <Cog className="h-5 w-5" />,
    status: "installed",
    settingsComponent: WorkersSettings as React.ComponentType<any>,
    settingsKeys: ["worker_heartbeat_timeout_ms", "worker_fallback_enabled", "worker_fallback_model", "openai_api_key", "anthropic_api_key", "google_ai_api_key"],
  },

  {
    id: "session-babysitter",
    name: "Session Babysitter",
    description: "Monitors sessions for crashes, stalls, and incomplete exits — auto-resumes interrupted work.",
    longDescription:
      "Four detection modes work together to keep sessions alive:\n\n" +
      "**Crash detection** — Claude dies mid-tool-execution (last message is tool_result). Auto-retries with context after a configurable delay.\n\n" +
      "**Incomplete exit detection** — Claude says \"I'll do X\" then the process dies before executing (last message is assistant, no result event in JSONL). Auto-resumes, checking first whether Claude was asking a question.\n\n" +
      "**Stall detection** — Process is alive but produces no output for >5 minutes. Uses Haiku to determine if Claude is genuinely waiting for user input before sending a nudge.\n\n" +
      "**Permission loop detection** — Repeated permission errors detected in JSONL. Escalates to a terminal session with --dangerously-skip-permissions.\n\n" +
      "All modes respect max retry limits and can be individually toggled. The orchestrator queue prevents concurrent overload.",
    category: "Orchestration",
    tags: ["built-in", "orchestration"],
    icon: <HeartPulse className="h-5 w-5" />,
    status: "installed",
    settingsComponent: BabysitterSettings as React.ComponentType<any>,
    settingsKeys: [
      "auto_retry_on_crash",
      "auto_continue_on_stall",
      "orchestrator_crash_retry_delay_ms",
      "orchestrator_stall_continue_delay_ms",
      "orchestrator_max_retries",
      "orchestrator_max_concurrent",
    ],
  },

  // ── Available (ready to install) ──
  {
    id: "permission-bridge",
    name: "permission-bridge",
    description: "Approve or deny Claude's permission prompts from the Session Manager web UI.",
    longDescription:
      "Installs a PermissionRequest hook that bridges Claude CLI's permission dialogs to the web UI. When Claude asks to use a tool, a banner appears in Session Manager with Allow/Deny buttons — no need to switch to the terminal.",
    category: "Permissions",
    tags: ["hook", "built-in"],
    icon: <ShieldCheck className="h-5 w-5" />,
    status: "available",
    settingsComponent: PermissionsSettings as React.ComponentType<any>,
    settingsKeys: ["dangerously_skip_permissions", "max_turns", "effort_level"],
  },
  {
    id: "safe-space-macos",
    name: "SafeSpace macOS",
    description: "Native macOS menubar app for real-time security scanning of AI coding sessions.",
    longDescription:
      "Monitors Claude Code sessions for prompt injection, credential exfiltration, and insecure configs. Lives in the menubar, scans automatically, alerts on threats. Built on the safe-space scanner engine.",
    category: "Security",
    tags: ["macos-app", "scanner"],
    icon: <Shield className="h-5 w-5" />,
    status: "available",
    standalone: true,
    repo: "Chill-AI-Space/safe-space-macos",
    links: [
      { label: "GitHub", href: "https://github.com/Chill-AI-Space/safe-space-macos" },
      { label: "Scanner", href: "https://github.com/Chill-AI-Space/safe-space" },
    ],
  },
  {
    id: "vault-mcp",
    name: "vault-mcp",
    description: "MCP server for credential isolation — bots use passwords without ever seeing them.",
    longDescription:
      "Stores secrets in macOS Keychain and exposes them via MCP tools. Claude can authenticate to services without credentials appearing in context. Zero-trust approach to AI credential management.",
    category: "Security",
    tags: ["mcp", "keychain"],
    icon: <Lock className="h-5 w-5" />,
    status: "available",
    standalone: true,
    repo: "Chill-AI-Space/vault-mcp",
    links: [
      { label: "GitHub", href: "https://github.com/Chill-AI-Space/vault-mcp" },
    ],
  },
  {
    id: "multi-playwright",
    name: "multi-playwright",
    description: "Project-isolated Chrome profiles for multiple Claude Code sessions.",
    longDescription:
      "Each project gets its own Chrome profile with separate cookies, auth, and history. No more cross-contamination between work accounts. Auto-selects profile based on working directory.",
    category: "Browser",
    tags: ["mcp", "browser"],
    icon: <Chrome className="h-5 w-5" />,
    status: "available",
    standalone: true,
    repo: "Chill-AI-Space/multi-playwright",
    links: [
      { label: "GitHub", href: "https://github.com/Chill-AI-Space/multi-playwright" },
    ],
  },
  {
    id: "claude-hooks",
    name: "claude-hooks",
    description: "Plugin runner for Claude Code hooks. One Node.js process, unlimited plugins.",
    longDescription:
      "Manages multiple hook plugins through a single entry point. Add, remove, and configure hooks without editing Claude's settings directly. Supports all hook types: UserPromptSubmit, PreToolUse, PostToolUse.",
    category: "Developer tools",
    tags: ["hook", "orchestration"],
    icon: <Plug className="h-5 w-5" />,
    status: "available",
    standalone: true,
    repo: "Chill-AI-Space/claude-hooks",
    links: [
      { label: "GitHub", href: "https://github.com/Chill-AI-Space/claude-hooks" },
    ],
  },
  {
    id: "session-snapshot",
    name: "session-snapshot",
    description: "Rolling JSONL snapshots for Claude Code sessions. Auto-restore after context overload.",
    longDescription:
      "Periodically saves session state so you can recover from context window exhaustion. When Claude loses track of what it was doing, restore from the last good snapshot instead of starting over.",
    category: "Context management",
    tags: ["hook", "orchestration"],
    icon: <Camera className="h-5 w-5" />,
    status: "available",
    standalone: true,
    repo: "Chill-AI-Space/session-snapshot",
    links: [
      { label: "GitHub", href: "https://github.com/Chill-AI-Space/session-snapshot" },
    ],
  },
  {
    id: "claude-session-anonymizer",
    name: "claude-session-anonymizer",
    description: "100% local tool to anonymize Claude Code sessions before sharing. Zero dependencies, zero API calls.",
    longDescription:
      "Strips personal data, file paths, secrets, and project-specific identifiers from session JSONL files. Share sessions publicly or with your team without leaking sensitive information.",
    category: "Privacy",
    tags: ["terminal"],
    icon: <Fingerprint className="h-5 w-5" />,
    status: "available",
    standalone: true,
    repo: "Chill-AI-Space/claude-session-anonymizer",
    links: [
      { label: "GitHub", href: "https://github.com/Chill-AI-Space/claude-session-anonymizer" },
    ],
  },
  {
    id: "new-session-from-reply",
    name: "New Session from Reply",
    description: "Start a new Claude session directly from the session detail panel with optional context carry-over.",
    longDescription:
      "Adds a toggle in the reply area: switch between replying to the current session or starting a fresh one. Choose a folder, optionally include the current session summary as context, and launch — all without leaving the page.",
    category: "Workflow",
    tags: ["built-in"],
    icon: <MessageSquare className="h-5 w-5" />,
    status: "available",
    settingsComponent: NewSessionFromReplySettings as React.ComponentType<any>,
    settingsKeys: ["google_ai_api_key"],
  },
  {
    id: "gated-knowledge",
    name: "gated-knowledge",
    description: "MCP server for searching and reading auth-gated sources: Google Drive, Sheets, BigQuery, Gmail, Notion, Slack, Telegram.",
    longDescription:
      "Local MCP server that gives Claude access to your auth-gated data sources. Search across Google Drive, Sheets, Gmail, Notion, Slack, and Telegram. Read documents, run BigQuery SQL queries, check email, and more — all from within Claude Code sessions.",
    category: "Knowledge management",
    tags: ["mcp", "data-source"],
    icon: <BookOpen className="h-5 w-5" />,
    status: "available",
    standalone: true,
    repo: "kobzevvv/gated-docs",
    links: [
      { label: "GitHub", href: "https://github.com/kobzevvv/gated-docs" },
      { label: "Docs", href: "https://kobzevvv.github.io/gated-docs/" },
    ],
  },

  // ── In progress ──
  {
    id: "chrome-content-log",
    name: "chrome-content-log",
    description: "Passive browser extension that captures and cleans page content as you browse.",
    longDescription:
      "Logs cleaned page content in the background as you browse. Build a searchable archive of everything you've read — perfect for research, competitive analysis, and knowledge management.",
    category: "Browser",
    tags: ["browser-ext", "data-source"],
    icon: <Chrome className="h-5 w-5" />,
    status: "in_progress",
    standalone: true,
    repo: "Chill-AI-Space/chrome-content-log",
    links: [
      { label: "GitHub", href: "https://github.com/Chill-AI-Space/chrome-content-log" },
    ],
  },
  {
    id: "artifacts-mcp",
    name: "artifacts-mcp",
    description: "Pre-compact context compression hook for Claude Code.",
    longDescription:
      "Intercepts context before Claude's built-in compaction runs and applies smarter compression strategies. Preserves key decisions, code references, and architectural context that naive compaction would destroy.",
    category: "Context management",
    tags: ["hook", "gemini"],
    icon: <Minimize2 className="h-5 w-5" />,
    status: "in_progress",
    standalone: true,
    repo: "Chill-AI-Space/artifacts-mcp",
    links: [
      { label: "GitHub", href: "https://github.com/Chill-AI-Space/artifacts-mcp" },
    ],
  },
  {
    id: "session-learnings",
    name: "session-learnings",
    description: "Extract patterns, bugs, preferences, and CLAUDE.md rules from completed sessions.",
    longDescription:
      "Post-session analysis that reads the transcript and extracts actionable learnings — coding patterns, gotchas, tool discoveries, and user preferences. Distributes findings to CLAUDE.md, memory files, and team docs.",
    category: "Analytics",
    tags: ["gemini", "orchestration"],
    icon: <Sparkles className="h-5 w-5" />,
    status: "in_progress",
  },

  // ── Requested ──
  {
    id: "email-to-session",
    name: "email-to-session",
    description: "Route incoming emails to Claude sessions for automated draft responses.",
    longDescription:
      "Receives emails via webhook, creates or routes to an existing Claude session, and generates draft replies. Perfect for support inboxes, sales follow-ups, and routine correspondence.",
    category: "Routing",
    tags: ["hook", "api"],
    icon: <Mail className="h-5 w-5" />,
    status: "requested",
  },
  {
    id: "session-search-engine",
    name: "session-search-engine",
    description: "Full-text search across all your Claude sessions with semantic ranking.",
    longDescription:
      "Indexes all session content and provides fast, relevant search results. Find that solution you built three weeks ago. Integrates with the session manager or works standalone via CLI.",
    category: "Search",
    tags: ["data-source", "terminal"],
    icon: <Search className="h-5 w-5" />,
    status: "requested",
  },
  {
    id: "plugin-registry",
    name: "plugin-registry",
    description: "Register your own tools, hooks, and MCP servers in the Store.",
    longDescription:
      "Self-service plugin registration. Point at a GitHub repo, and the Store picks up name, description, install command, and tags automatically. Community plugins appear alongside built-in ones.",
    category: "Developer tools",
    tags: ["api"],
    icon: <Terminal className="h-5 w-5" />,
    status: "requested",
  },
];
