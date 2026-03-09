"use client";

import { useState } from "react";
import {
  ArrowLeft, Package, CheckCircle2, ExternalLink, Link2,
  BookOpen, Minimize2, Shield, Chrome, Fingerprint, Lock,
  Plug, Camera, Construction, MessageSquare, Mail, Search,
  Sparkles, Terminal, ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";

type PluginStatus = "installed" | "available" | "in_progress" | "requested";

interface Plugin {
  id: string;
  name: string;
  description: string;
  longDescription: string;
  category: string;
  tags: string[];
  icon: React.ReactNode;
  status: PluginStatus;
  standalone?: boolean;
  repo?: string;
  links?: { label: string; href: string }[];
}

const PLUGINS: Plugin[] = [
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
  },

  // ── In progress (community projects) ──
  {
    id: "chrome-content-log",
    name: "chrome-content-log",
    description: "Passive browser extension that captures and cleans page content as you browse. Your personal research memory.",
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

  // ── Requested (ideas / planned) ──
  {
    id: "auto-continue",
    name: "auto-continue",
    description: "Detects when Claude stops mid-task and automatically sends \"continue\" to resume work.",
    longDescription:
      "Watches session activity and sends a follow-up prompt when Claude goes silent but the task isn't done. Configurable idle timeout and trigger conditions. Never lose momentum on long tasks.",
    category: "Orchestration",
    tags: ["hook", "orchestration"],
    icon: <MessageSquare className="h-5 w-5" />,
    status: "requested",
  },
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
    id: "gated-info",
    name: "gated-info",
    description: "MCP server for searching and reading auth-gated sources: Google Drive, Sheets, BigQuery, Gmail, Notion, Slack, Telegram.",
    longDescription:
      "Local MCP server that gives Claude access to your auth-gated data sources. Search across Google Drive, Sheets, Gmail, Notion, Slack, and Telegram. Read documents, run BigQuery SQL queries, check email, and more — all from within Claude Code sessions.",
    category: "Knowledge management",
    tags: ["mcp", "data-source"],
    icon: <BookOpen className="h-5 w-5" />,
    status: "available",
    standalone: true,
    repo: "kobzevvv/gated-info",
    links: [
      { label: "GitHub", href: "https://github.com/kobzevvv/gated-info" },
      { label: "Docs", href: "https://kobzevvv.github.io/gated-info/" },
    ],
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

const STATUS_CONFIG: Record<PluginStatus, { label: string; className: string; bgClassName: string }> = {
  installed: { label: "Installed", className: "text-green-600 dark:text-green-400", bgClassName: "border-border bg-card hover:border-border/80" },
  available: { label: "Available", className: "text-muted-foreground", bgClassName: "border-border bg-card hover:border-border/80" },
  in_progress: { label: "In progress", className: "text-amber-600 dark:text-amber-400", bgClassName: "border-amber-500/20 bg-card/60" },
  requested: { label: "Requested", className: "text-blue-600 dark:text-blue-400", bgClassName: "border-blue-500/15 bg-blue-500/[0.03]" },
};

export default function StorePage() {
  const [plugins, setPlugins] = useState(PLUGINS);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installLog, setInstallLog] = useState<string | null>(null);

  // Check permission-bridge install status on mount
  useState(() => {
    fetch("/api/permissions/install")
      .then((r) => r.json())
      .then((data) => {
        if (data.installed) {
          setPlugins((prev) =>
            prev.map((p) => (p.id === "permission-bridge" ? { ...p, status: "installed" as const } : p))
          );
        }
      })
      .catch(() => {});
    // Check setting-backed plugins
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        if (data.new_session_from_reply === "true") {
          setPlugins((prev) =>
            prev.map((p) => (p.id === "new-session-from-reply" ? { ...p, status: "installed" as const } : p))
          );
        }
      })
      .catch(() => {});
  });

  const toggleInstall = async (id: string) => {
    // Special handling for permission-bridge — real install/uninstall
    if (id === "permission-bridge") {
      const plugin = plugins.find((p) => p.id === id);
      if (!plugin) return;
      setInstalling(id);
      setInstallLog(null);
      try {
        if (plugin.status === "installed") {
          const res = await fetch("/api/permissions/install", { method: "DELETE" });
          const data = await res.json();
          setInstallLog(data.log);
          if (data.ok) {
            setPlugins((prev) => prev.map((p) => (p.id === id ? { ...p, status: "available" as const } : p)));
          }
        } else {
          const res = await fetch("/api/permissions/install", { method: "POST" });
          const data = await res.json();
          setInstallLog(data.log);
          if (data.ok) {
            setPlugins((prev) => prev.map((p) => (p.id === id ? { ...p, status: "installed" as const } : p)));
          }
        }
      } catch (e) {
        setInstallLog(`Error: ${e}`);
      } finally {
        setInstalling(null);
      }
      return;
    }

    // Setting-backed plugins — toggle via settings API
    const settingKey: Record<string, string> = {
      "new-session-from-reply": "new_session_from_reply",
    };
    if (settingKey[id]) {
      const plugin = plugins.find((p) => p.id === id);
      if (!plugin) return;
      const newValue = plugin.status === "installed" ? "false" : "true";
      try {
        await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [settingKey[id]]: newValue }),
        });
        setPlugins((prev) =>
          prev.map((p) =>
            p.id === id
              ? { ...p, status: newValue === "true" ? "installed" as const : "available" as const }
              : p
          )
        );
      } catch { /* best effort */ }
      return;
    }

    // Default toggle for other plugins
    setPlugins((prev) =>
      prev.map((p) => {
        if (p.id !== id) return p;
        if (p.status === "in_progress" || p.status === "requested") return p;
        return { ...p, status: p.status === "installed" ? "available" as const : "installed" as const };
      })
    );
  };

  // Group by status for section headers
  const groups = ([
    { status: "installed" as const, label: "Installed", items: plugins.filter((p) => p.status === "installed") },
    { status: "available" as const, label: "Available", items: plugins.filter((p) => p.status === "available") },
    { status: "in_progress" as const, label: "In progress", items: plugins.filter((p) => p.status === "in_progress") },
    { status: "requested" as const, label: "Requested", items: plugins.filter((p) => p.status === "requested") },
  ] satisfies { status: PluginStatus; label: string; items: Plugin[] }[]).filter((g) => g.items.length > 0);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-6">
        <Link
          href="/claude-sessions"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-4"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to sessions
        </Link>

        <div className="flex items-center gap-2 mb-6">
          <Package className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Store</h1>
          <span className="text-xs text-muted-foreground/50">{plugins.length} plugins</span>
        </div>

        {groups.map((group) => (
          <div key={group.status} className="mb-6">
            <div className="flex items-center gap-2 mb-2">
              <span className={`text-xs font-medium ${STATUS_CONFIG[group.status].className}`}>
                {group.label}
              </span>
              <span className="text-[10px] text-muted-foreground/40">{group.items.length}</span>
              <div className="flex-1 h-px bg-border/30" />
            </div>
            <div className="space-y-3">
              {group.items.map((plugin) => {
                const statusCfg = STATUS_CONFIG[plugin.status];
                return (
                  <div
                    key={plugin.id}
                    className={`border rounded-lg p-4 transition-colors ${statusCfg.bgClassName}`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="shrink-0 mt-0.5 text-muted-foreground">
                        {plugin.icon}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-3 mb-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="text-sm font-medium">{plugin.name}</h3>
                            <span className="text-[10px] text-muted-foreground/60 bg-muted/50 px-1.5 py-0.5 rounded">
                              {plugin.category}
                            </span>
                            {plugin.standalone && (
                              <span className="text-[10px] text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded">
                                standalone
                              </span>
                            )}
                            {plugin.status === "in_progress" && (
                              <span className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">
                                <Construction className="h-2.5 w-2.5" />
                                Community project
                              </span>
                            )}
                          </div>
                          {plugin.tags.length > 0 && (
                            <div className="flex items-center gap-1.5 shrink-0">
                              {plugin.tags.map((tag) => (
                                <span key={tag} className="text-[11px] font-mono text-muted-foreground/60 bg-muted/30 border border-border/50 px-2 py-1 rounded-md">
                                  {tag}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground leading-relaxed mb-2">
                          {plugin.description}
                        </p>
                        <p className="text-[11px] text-muted-foreground/60 leading-relaxed mb-3">
                          {plugin.longDescription}
                        </p>
                        <div className="flex items-center gap-2">
                          {plugin.status === "in_progress" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs gap-1.5 border-amber-500/30 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10"
                              disabled
                            >
                              <Construction className="h-3 w-3" />
                              In progress
                            </Button>
                          ) : plugin.status === "requested" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs gap-1.5 border-blue-500/30 text-blue-600 dark:text-blue-400 hover:bg-blue-500/10"
                              disabled
                            >
                              <Sparkles className="h-3 w-3" />
                              Requested
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant={plugin.status === "installed" ? "secondary" : "default"}
                              className="h-7 text-xs gap-1.5"
                              onClick={() => toggleInstall(plugin.id)}
                              disabled={installing === plugin.id}
                            >
                              {installing === plugin.id ? (
                                <>Installing...</>
                              ) : plugin.status === "installed" ? (
                                <>
                                  <CheckCircle2 className="h-3 w-3" />
                                  Installed
                                </>
                              ) : plugin.id === "permission-bridge" ? (
                                <>Install</>
                              ) : plugin.standalone ? (
                                <>Standalone install</>
                              ) : (
                                <>Get</>
                              )}
                            </Button>
                          )}
                          {plugin.links?.map((link) => (
                            <a
                              key={link.href}
                              href={link.href}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                            >
                              <ExternalLink className="h-2.5 w-2.5" />
                              {link.label}
                            </a>
                          ))}
                        </div>
                        {installLog && plugin.id === "permission-bridge" && (
                          <pre className="mt-2 text-[10px] text-muted-foreground bg-muted/50 border border-border/30 rounded p-2 whitespace-pre-wrap font-mono max-h-32 overflow-y-auto">
                            {installLog}
                          </pre>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        <div className="mt-6 text-center">
          <p className="text-xs text-muted-foreground/40">
            More plugins coming soon. Have an idea?{" "}
            <a
              href="https://github.com/Chill-AI-Space"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-muted-foreground"
            >
              Open a feature request
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
