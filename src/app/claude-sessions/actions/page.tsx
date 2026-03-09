"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  Loader2, ClipboardList, RefreshCw, ChevronDown, ChevronRight,
  Download, Zap, AlertTriangle, Clock, Send, Activity, Timer, X,
  Pause, Play
} from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";

interface ActionEntry {
  id: number;
  type: "service" | "settings";
  action: string;
  details: string | null;
  payload: string | null;
  session_id: string | null;
  created_at: string;
}

interface Stats {
  total_24h: number;
  crashes_24h: number;
  retries_24h: number;
  retries_failed_24h: number;
  stalls_24h: number;
  replies_24h: number;
  last_crash: string | null;
  last_action: string | null;
}

// ── Constants ──────────────────────────────────────────────────────────────

const ACTION_LABELS: Record<string, string> = {
  reply: "Reply sent",
  kill_terminal: "Kill terminal",
  open_in_terminal: "Open in terminal",
  focus_terminal: "Focus terminal",
  launch: "Launch session",
  start_web_session: "Start web session",
  ui_open_session: "Opened session",
  teamhub_inject: "TeamHub inject",
  context_source_inject: "Context inject",
  crash_detected: "Crash detected",
  auto_retry_fired: "Auto-retry started",
  auto_retry_done: "Auto-retry OK",
  auto_retry_failed: "Auto-retry FAILED",
  stall_detected: "Stall detected",
  stall_continue_fired: "Auto-continue sent",
  stall_continue_skipped: "Auto-continue skipped",
  stall_continue_done: "Auto-continue OK",
  stall_continue_failed: "Auto-continue FAILED",
  analytics_generate: "Analytics query",
};

const ERROR_ACTIONS = new Set([
  "crash_detected", "auto_retry_failed", "stall_continue_failed",
]);
const WARNING_ACTIONS = new Set([
  "stall_detected", "auto_retry_fired", "stall_continue_fired",
]);
const SUCCESS_ACTIONS = new Set([
  "auto_retry_done", "stall_continue_done",
]);

const QUICK_FILTERS = [
  { id: "all", label: "All", actions: "" },
  { id: "errors", label: "Errors", actions: "crash_detected,auto_retry_failed,stall_continue_failed" },
  { id: "recovery", label: "Recovery", actions: "crash_detected,auto_retry_fired,auto_retry_done,auto_retry_failed,stall_detected,stall_continue_fired,stall_continue_done,stall_continue_failed,stall_continue_skipped" },
  { id: "stalls", label: "Stalls", actions: "stall_detected,stall_continue_fired,stall_continue_done,stall_continue_failed,stall_continue_skipped" },
  { id: "replies", label: "Replies", actions: "reply" },
  { id: "launches", label: "Launches", actions: "launch,start_web_session" },
  { id: "settings", label: "Settings", actions: "" },
] as const;

// ── Helpers ────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso + "Z").getTime();
  if (ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

function absoluteTime(iso: string): string {
  return new Date(iso + "Z").toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function rowBg(action: string): string {
  if (ERROR_ACTIONS.has(action)) return "bg-red-500/5 dark:bg-red-500/8";
  if (WARNING_ACTIONS.has(action)) return "bg-amber-500/5 dark:bg-amber-500/8";
  if (SUCCESS_ACTIONS.has(action)) return "bg-green-500/5 dark:bg-green-500/8";
  return "";
}

function actionColor(action: string): string {
  if (ERROR_ACTIONS.has(action)) return "text-red-600 dark:text-red-400 font-semibold";
  if (WARNING_ACTIONS.has(action)) return "text-amber-600 dark:text-amber-400 font-medium";
  if (SUCCESS_ACTIONS.has(action)) return "text-green-600 dark:text-green-400";
  if (action === "reply") return "text-blue-600 dark:text-blue-400";
  if (action === "teamhub_inject") return "text-yellow-600 dark:text-yellow-400 font-medium";
  if (action === "context_source_inject") return "text-blue-600 dark:text-blue-400 font-medium";
  if (action.startsWith("launch") || action === "start_web_session") return "text-green-600 dark:text-green-400";
  if (action.startsWith("set_")) return "text-muted-foreground";
  return "";
}

function actionIcon(action: string) {
  if (ERROR_ACTIONS.has(action)) return <AlertTriangle className="h-3 w-3 text-red-500 shrink-0" />;
  if (WARNING_ACTIONS.has(action)) return <Clock className="h-3 w-3 text-amber-500 shrink-0" />;
  if (SUCCESS_ACTIONS.has(action)) return <Zap className="h-3 w-3 text-green-500 shrink-0" />;
  return null;
}

// ── Stat Card ──────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color }: {
  label: string; value: number; sub?: string; color: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-2.5 rounded-lg border border-border bg-card min-w-[120px]">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">{label}</span>
      <span className={`text-xl font-bold tabular-nums ${color}`}>{value}</span>
      {sub && <span className="text-[10px] text-muted-foreground">{sub}</span>}
    </div>
  );
}

// ── Action Row ─────────────────────────────────────────────────────────────

function ActionRow({ e, onSessionClick }: {
  e: ActionEntry;
  onSessionClick: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasPayload = !!e.payload;

  return (
    <>
      <tr
        className={`border-b border-border/40 transition-colors ${rowBg(e.action)} ${hasPayload ? "cursor-pointer hover:bg-muted/40" : "hover:bg-muted/20"}`}
        onClick={() => hasPayload && setExpanded((v) => !v)}
      >
        <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap tabular-nums" title={absoluteTime(e.created_at)}>
          {relativeTime(e.created_at)}
        </td>
        <td className="px-3 py-1.5">
          <span className={`flex items-center gap-1.5 ${actionColor(e.action)}`}>
            {actionIcon(e.action)}
            {ACTION_LABELS[e.action] ?? e.action.replace(/_/g, " ").replace(/^set /, "")}
          </span>
        </td>
        <td className="px-3 py-1.5 text-muted-foreground max-w-[400px] truncate">
          <span className="flex items-center gap-1">
            {hasPayload && (
              expanded
                ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
            )}
            <span title={e.details ?? ""}>{e.details ?? ""}</span>
          </span>
        </td>
        <td className="px-3 py-1.5" onClick={(ev) => ev.stopPropagation()}>
          {e.session_id ? (
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => onSessionClick(e.session_id!)}
                className="font-mono text-muted-foreground hover:text-foreground transition-colors underline decoration-dotted underline-offset-2"
                title="Filter by this session"
              >
                {e.session_id.slice(0, 8)}
              </button>
              <Link
                href={`/claude-sessions/${e.session_id}`}
                className="text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                title="Open session"
              >
                <Activity className="h-3 w-3" />
              </Link>
              <a
                href={`/api/sessions/${e.session_id}/export?format=text`}
                download={`${e.session_id.slice(0, 8)}-messages.txt`}
                className="text-muted-foreground/30 hover:text-muted-foreground/60 transition-colors"
                title="Download messages"
              >
                <Download className="h-3 w-3" />
              </a>
            </div>
          ) : (
            <span className="text-muted-foreground/30">—</span>
          )}
        </td>
      </tr>
      {expanded && e.payload && (
        <tr className={`border-b border-border/40 ${rowBg(e.action)}`}>
          <td colSpan={4} className="px-3 py-2">
            <pre className="text-[11px] font-mono text-foreground/80 whitespace-pre-wrap break-all max-h-[300px] overflow-y-auto leading-relaxed bg-background/60 border border-border rounded p-3">
              {e.payload}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function ActionsDebugger() {
  const [entries, setEntries] = useState<ActionEntry[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState("all");
  const [sessionFilter, setSessionFilter] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const autoRefreshRef = useRef(autoRefresh);
  autoRefreshRef.current = autoRefresh;
  const lastEntryIdRef = useRef(0);
  const [newCount, setNewCount] = useState(0);

  const load = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const params = new URLSearchParams();

      if (sessionFilter) {
        params.set("session_id", sessionFilter);
      } else {
        const filterDef = QUICK_FILTERS.find(f => f.id === activeFilter);
        if (filterDef && filterDef.id === "settings") {
          params.set("type", "settings");
        } else if (filterDef?.actions) {
          params.set("action", filterDef.actions);
        }
      }

      const [entriesRes, statsRes] = await Promise.all([
        fetch(`/api/actions-log?${params}`),
        fetch("/api/actions-log?stats=1"),
      ]);
      const [entriesData, statsData] = await Promise.all([
        entriesRes.json(),
        statsRes.json(),
      ]);

      setEntries(entriesData);
      setStats(statsData);

      // Track new entries for the pulse indicator
      if (entriesData.length > 0) {
        const topId = entriesData[0].id;
        if (lastEntryIdRef.current > 0 && topId > lastEntryIdRef.current) {
          setNewCount(topId - lastEntryIdRef.current);
          setTimeout(() => setNewCount(0), 3000);
        }
        lastEntryIdRef.current = topId;
      }
    } finally {
      setLoading(false);
    }
  }, [activeFilter, sessionFilter]);

  useEffect(() => { load(true); }, [load]);

  // Auto-refresh every 5s
  useEffect(() => {
    const id = setInterval(() => {
      if (autoRefreshRef.current) load();
    }, 5000);
    return () => clearInterval(id);
  }, [load]);

  function handleSessionClick(id: string) {
    setSessionFilter(prev => prev === id ? null : id);
    setActiveFilter("all");
  }

  function handleFilterClick(filterId: string) {
    setActiveFilter(filterId);
    setSessionFilter(null);
  }

  const retrySuccessRate = stats
    ? stats.retries_24h > 0
      ? Math.round(((stats.retries_24h - stats.retries_failed_24h) / stats.retries_24h) * 100)
      : null
    : null;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-border px-5 py-3 flex items-center gap-3 shrink-0">
        <ClipboardList className="h-4 w-4 text-muted-foreground" />
        <h1 className="text-sm font-semibold">Debugger</h1>

        {sessionFilter && (
          <div className="flex items-center gap-1 bg-blue-500/10 text-blue-600 dark:text-blue-400 px-2 py-0.5 rounded text-xs font-mono">
            session: {sessionFilter.slice(0, 8)}
            <button onClick={() => setSessionFilter(null)} className="hover:text-foreground ml-1">
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {newCount > 0 && (
            <span className="text-[10px] text-green-500 animate-pulse">+{newCount} new</span>
          )}
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {entries.length} entries
          </span>
          <Button
            variant="ghost"
            size="icon"
            className={`h-7 w-7 ${autoRefresh ? "text-green-500" : "text-muted-foreground"}`}
            onClick={() => setAutoRefresh(v => !v)}
            title={autoRefresh ? "Auto-refresh ON (5s)" : "Auto-refresh OFF"}
          >
            {autoRefresh ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => load(true)} title="Refresh now">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Stats cards */}
      {stats && (
        <div className="border-b border-border px-5 py-3 flex gap-3 overflow-x-auto shrink-0">
          <StatCard label="Last 24h" value={stats.total_24h} color="text-foreground" />
          <StatCard
            label="Crashes"
            value={stats.crashes_24h}
            sub={stats.last_crash ? `last: ${relativeTime(stats.last_crash)}` : "none"}
            color={stats.crashes_24h > 0 ? "text-red-500" : "text-green-500"}
          />
          <StatCard
            label="Auto-recovery"
            value={stats.retries_24h}
            sub={retrySuccessRate !== null ? `${retrySuccessRate}% success` : "no attempts"}
            color={stats.retries_failed_24h > 0 ? "text-amber-500" : "text-foreground"}
          />
          <StatCard label="Stalls" value={stats.stalls_24h} color={stats.stalls_24h > 0 ? "text-purple-500" : "text-foreground"} />
          <StatCard label="Replies" value={stats.replies_24h} color="text-blue-500" />
        </div>
      )}

      {/* Filter bar */}
      <div className="border-b border-border px-5 py-2 flex gap-1 shrink-0 overflow-x-auto">
        {QUICK_FILTERS.map(f => (
          <button
            key={f.id}
            onClick={() => handleFilterClick(f.id)}
            className={`px-2.5 py-1 rounded text-xs transition-colors whitespace-nowrap ${
              activeFilter === f.id && !sessionFilter
                ? "bg-foreground text-background font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-sm text-muted-foreground gap-2">
            <ClipboardList className="h-8 w-8 opacity-30" />
            <p>No entries{sessionFilter ? " for this session" : ""}.</p>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-background/95 backdrop-blur-sm border-b border-border z-10">
              <tr className="text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium w-[90px]">Time</th>
                <th className="px-3 py-2 font-medium w-[180px]">Action</th>
                <th className="px-3 py-2 font-medium">Details</th>
                <th className="px-3 py-2 font-medium w-[120px]">Session</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <ActionRow key={e.id} e={e} onSessionClick={handleSessionClick} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
