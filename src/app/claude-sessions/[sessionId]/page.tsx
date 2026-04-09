"use client";

import { useEffect, useState, useCallback, useRef, use, useMemo } from "react";
import { useTriggerNotification, clearTabBadge } from "@/hooks/useNotifications";
import { useRouter, useSearchParams } from "next/navigation";
import { MessageView } from "@/components/MessageView";
import { ReplyInput, ReplyInputHandle } from "@/components/ReplyInput";
import { ParsedMessage, SessionRow } from "@/lib/types";
import { Loader2, GitBranch, Hash, Terminal, X, Settings, Crosshair, ShieldAlert, Share2, Copy, Check, ChevronsDownUp, ChevronsUpDown, Download, Sparkles, BarChart2, ClipboardList, Archive, CircleHelp, Package, Lightbulb, Sun, Moon, ShieldCheck, ShieldOff, Plus, FolderOpen, FolderPlus, AlertTriangle, PanelRightClose, PanelRight, Paperclip, Bug, Flame, Repeat, Zap, Rocket, FileText, ScrollText, MessageSquare, Monitor, Cloud } from "lucide-react";
import { toast, Toaster } from "sonner";
import { formatTokens } from "@/lib/utils";
import { getActivityStatus } from "@/lib/activity-status";
import { getCachedSession, setCachedSession } from "@/lib/session-cache";
import { checkContextGuard } from "@/lib/context-guard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";
import Link from "next/link";
import { FolderBrowserDialog } from "@/components/FolderBrowserDialog";
import { MODEL_PRESETS } from "@/components/settings/ModelSelector";
import { useAutodetect } from "@/hooks/useAutodetect";
import { MarkdownContent } from "@/components/MarkdownContent";
import { useSettingToggle } from "@/hooks/useSettingToggle";
import { useDynamicFavicon } from "@/hooks/useDynamicFavicon";
import { useComputeNode } from "@/hooks/useComputeNode";
import { AgentToggleButton, type AgentType, DEFAULT_MODEL } from "@/components/AgentToggleButton";


const CTX_MAX = 200_000;

// Backoff polling schedule after activity ends: [delay_ms × 3 each] ≈ 20 min total
const BACKOFF_DELAYS = [
  ...Array(3).fill(3_000),
  ...Array(3).fill(5_000),
  ...Array(3).fill(10_000),
  ...Array(3).fill(30_000),
  ...Array(3).fill(60_000),
  ...Array(3).fill(300_000),
];

/** Runs `callback` on an exponential backoff schedule. Restarts when `trigger` changes. */
function useBackoffPoll(callback: () => void, trigger: number) {
  const cbRef = useRef(callback);
  cbRef.current = callback;
  useEffect(() => {
    if (trigger === 0) return;
    let cancelled = false;
    let idx = 0;
    const next = () => {
      if (cancelled || idx >= BACKOFF_DELAYS.length) return;
      setTimeout(() => {
        if (cancelled) return;
        cbRef.current();
        idx++;
        next();
      }, BACKOFF_DELAYS[idx]);
    };
    next();
    return () => { cancelled = true; };
  }, [trigger]);
}

function ContextBar({ tokens }: { tokens: number }) {
  const pct = Math.min((tokens / CTX_MAX) * 100, 100);
  const color =
    pct >= 80 ? "bg-red-500" : pct >= 50 ? "bg-yellow-500" : "bg-green-500";
  const textColor =
    pct >= 80 ? "text-red-500" : pct >= 50 ? "text-yellow-500" : "text-green-500/80";
  return (
    <div className="flex items-center gap-2 mt-1">
      <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden max-w-[140px]">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-[10px] font-mono shrink-0 ${textColor}`}>
        {formatTokens(tokens)}<span className="text-muted-foreground/40">/200k</span>
      </span>
    </div>
  );
}


function FocusErrorBanner({ error }: { error: string }): React.ReactElement {
  return (
    <div className="flex items-start gap-1.5 px-4 pb-2 text-[11px] text-amber-600 dark:text-amber-400">
      <ShieldAlert className="h-3.5 w-3.5 shrink-0 mt-px" />
      <span>
        {error}{" "}
        <a
          href="x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
          className="underline underline-offset-2 hover:opacity-80"
        >
          Open Accessibility settings
        </a>
        {" -- add Terminal.app or iTerm2."}
      </span>
    </div>
  );
}

interface ProcessVitals {
  pid: number;
  cpu_percent: number;
  mem_mb: number;
  has_established_tcp: boolean;
  tcp_connections: string[];
  elapsed_secs: number;
}

interface SessionDetailData {
  session_id: string;
  project_path: string;
  messages: ParsedMessage[];
  messages_start: number;
  messages_total: number;
  metadata: SessionRow;
  is_active: boolean;
  has_result?: boolean;
  file_age_ms?: number;
  process_vitals?: ProcessVitals | null;
}

export default function SessionDetailPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const highlightQuery = searchParams.get("q") || null;
  const remoteNodeId = searchParams.get("node") || null;

  /** Build API URL, appending ?node= for remote sessions */
  const apiUrl = useCallback((path: string, extraParams?: Record<string, string>) => {
    const params = new URLSearchParams(extraParams);
    if (remoteNodeId) params.set("node", remoteNodeId);
    const qs = params.toString();
    return `${path}${qs ? `?${qs}` : ""}`;
  }, [remoteNodeId]);
  const [data, setData] = useState<SessionDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // All pending/streaming messages shown below the server data
  const [extraMessages, setExtraMessages] = useState<ParsedMessage[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  const [statusHistory, setStatusHistory] = useState<string[]>([]);
  // Track last time we received ANY data on the SSE stream (for stale detection)
  const lastStreamEventRef = useRef<number>(0);

  // Message queue: messages waiting to be sent
  const queueRef = useRef<string[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<string[]>([]);
  const processingRef = useRef(false);
  // Abort controller for cancelling in-flight requests on session switch
  const abortRef = useRef<AbortController | null>(null);

  // Pagination for large sessions
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierMessages, setEarlierMessages] = useState<ParsedMessage[]>([]);
  const [earliestLoaded, setEarliestLoaded] = useState<number | null>(null);

  // Highlight a specific message (from search)
  const [highlightId, setHighlightId] = useState<string | null>(null);

  // Track if we've killed the terminal for this session (to hide the button)
  const [terminalKilled, setTerminalKilled] = useState(false);
  const [hasReplied, setHasReplied] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [focusError, setFocusError] = useState<string | null>(null);
  const [focusOk, setFocusOk] = useState(false);

  const replyInputRef = useRef<ReplyInputHandle>(null);

  // Settings for status bar
  const [settings, setSettings] = useState<Record<string, string> | null>(null);

  // Fold chat
  const [folded, setFolded] = useState(false);

  // Right panel collapse
  const [rightPanelOpen, setRightPanelOpen] = useState(true);

  // Share
  const [shareState, setShareState] = useState<"idle" | "loading" | "done">("idle");
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Sent message confirmation (shown in right panel)
  const [lastSentText, setLastSentText] = useState<string | null>(null);

  // Skip Permissions warning
  const [skipPermsDialog, setSkipPermsDialog] = useState<{ message: string } | null>(null);
  const [skipPermsShown, setSkipPermsShown] = useState(false);

  // Learnings
  const [learnings, setLearnings] = useState<Record<string, unknown> | null>(null);
  const [learningsLoading, setLearningsLoading] = useState(false);
  const [learningsError, setLearningsError] = useState<string | null>(null);
  const [learningsOpen, setLearningsOpen] = useState(false);

  // MD view (default — primary display mode)
  const [mdView, setMdView] = useState(true);
  const [mdContent, setMdContent] = useState<string | null>(null);
  const [mdLoading, setMdLoading] = useState(false);
  const mdScrollRef = useRef<HTMLDivElement>(null);
  const mdIsNearBottomRef = useRef(true);
  const mdInitialLoadRef = useRef<string | null>(null); // tracks sessionId of initial load
  const [mdHasEarlier, setMdHasEarlier] = useState(false);
  const [mdRenderStart, setMdRenderStart] = useState(0);
  const [mdLoadingEarlier, setMdLoadingEarlier] = useState(false);

  // Summary
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);

  // New session mode
  const [replyMode, setReplyMode] = useState<"reply" | "new" | "issue">("reply");
  const [newSessionAgent, setNewSessionAgent] = useState<AgentType>("claude");
  const [newSessionPath, setNewSessionPath] = useState<string | null>(null);
  const [includeSummary, setIncludeSummary] = useState(true);
  const [startingNewSession, setStartingNewSession] = useState(false);
  const [newSessionModel, setNewSessionModel] = useState("");
  const [showNewSessionOpts, setShowNewSessionOpts] = useState(false);
  const [folderBrowserOpen, setFolderBrowserOpen] = useState(false);
  const [newSessionMessage, setNewSessionMessage] = useState("");
  const newSessionInputRef = useRef<HTMLTextAreaElement>(null);
  const newFileInputRef = useRef<HTMLInputElement>(null);
  const [newSessionDragging, setNewSessionDragging] = useState(false);
  const newDragCounterRef = useRef(0);
  const newAutodetect = useAutodetect();
  const skipPerms = useSettingToggle("dangerously_skip_permissions");
  const compute = useComputeNode();

  // Issue submission
  const [issueCategory, setIssueCategory] = useState<string | null>(null);
  const [issueDescription, setIssueDescription] = useState("");
  const [isSubmittingIssue, setIsSubmittingIssue] = useState(false);
  const issueInputRef = useRef<HTMLTextAreaElement>(null);

  // Permission bridge
  interface PendingPermission {
    id: string;
    sessionId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    cwd: string;
    createdAt: number;
  }
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermission[]>([]);

  useEffect(() => {
    const saved = localStorage.getItem("theme") as "light" | "dark" | null;
    setTheme(saved === "light" ? "light" : "dark");
  }, []);

  // Poll for pending permission requests (every 2s) — only when session is active
  useEffect(() => {
    if (!data?.is_active && !isStreaming) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/permissions/pending?sessionId=${sessionId}`);
        if (!res.ok || cancelled) return;
        const json = await res.json();
        if (!cancelled) setPendingPermissions(json);
      } catch { /* ignore */ }
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, [sessionId, data?.is_active, isStreaming]);

  const handlePermissionDecide = async (id: string, behavior: "allow" | "deny") => {
    try {
      await fetch(`/api/permissions/${id}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ behavior }),
      });
      setPendingPermissions((prev) => prev.filter((p) => p.id !== id));
    } catch { /* ignore */ }
  };

  // Context Guard
  const [contextGuardDialog, setContextGuardDialog] = useState<{
    open: boolean;
    message: string;
    score: number;
  } | null>(null);
  const [contextGuardError, setContextGuardError] = useState<string | null>(null);

  const prevTotalRef = useRef(0);
  // Counter to invalidate stale fetches without using AbortController (avoids unhandled rejection in Next.js dev overlay)
  const fetchGenRef = useRef(0);
  const fetchSession = useCallback(async ({ clearExtras = false } = {}) => {
    const gen = ++fetchGenRef.current;
    try {
      const res = await fetch(apiUrl(`/api/sessions/${sessionId}`));
      if (gen !== fetchGenRef.current) return; // stale
      if (!res.ok) {
        setError("Session not found");
        return;
      }
      const json = await res.json();
      if (gen !== fetchGenRef.current) return; // stale
      const prevTotal = prevTotalRef.current;
      prevTotalRef.current = json.messages_total;
      setCachedSession(sessionId, json);
      setData(json);
      setEarliestLoaded(json.messages_start);
      // Clear optimistic extras whenever server data has grown (prevents duplicates)
      if (clearExtras || json.messages_total > prevTotal) {
        setExtraMessages([]);
      }
      if (clearExtras) {
        setEarlierMessages([]);
      }
    } catch {
      if (gen !== fetchGenRef.current) return; // stale
      setError("Failed to load session");
    } finally {
      setLoading(false);
    }
  }, [sessionId, apiUrl]);

  // Backoff polling trigger — incremented to start a new backoff cycle
  const [backoffTrigger, setBackoffTrigger] = useState(0);
  const startBackoff = useCallback(() => setBackoffTrigger((t) => t + 1), []);
  useBackoffPoll(fetchSession, backoffTrigger);

  const loadEarlierMessages = useCallback(async () => {
    if (earliestLoaded === null || earliestLoaded === 0) return;
    setLoadingEarlier(true);
    try {
      const res = await fetch(apiUrl(`/api/sessions/${sessionId}`, { before: String(earliestLoaded) }));
      if (!res.ok) return;
      const json = await res.json();
      if (!Array.isArray(json.messages)) return;
      setEarlierMessages((prev) => [...json.messages, ...prev]);
      setEarliestLoaded(json.messages_start);
    } catch {
      // Network error — spinner disappears, user can retry by clicking button again
    } finally {
      setLoadingEarlier(false);
    }
  }, [sessionId, earliestLoaded, apiUrl]);

  useEffect(() => {
    // Abort any in-flight streaming request from previous session
    abortRef.current?.abort("cancelled");
    abortRef.current = null;

    setError(null);
    setExtraMessages([]);
    setEarlierMessages([]);
    setHighlightId(null);
    setStreamingText("");
    setIsStreaming(false);
    setStreamError(null);
    setStreamStatus(null);
    lastStreamEventRef.current = 0;
    setTerminalKilled(false);
    setHasReplied(false);
    setMdView(true);
    setMdContent(null);
    setMdLoading(false);
    setMdHasEarlier(false);
    setMdRenderStart(0);
    setMdLoadingEarlier(false);
    setSummary(null);
    setSummaryOpen(false);
    queueRef.current = [];
    processingRef.current = false;
    prevTotalRef.current = 0;
    prevMdTotalRef.current = 0;

    // Stale-while-revalidate: show cached data instantly, fetch fresh in background
    const cached = getCachedSession(sessionId);
    if (cached) {
      setData(cached);
      setEarliestLoaded(cached.messages_start);
      prevTotalRef.current = cached.messages_total;
      setLoading(false);
    } else {
      setLoading(true);
      setEarliestLoaded(null);
    }
    fetchSession().catch(() => {});
    // Fetch settings for status bar
    fetch("/api/settings").then(r => r.json()).then(setSettings).catch(() => {});
    // Log UI load event
    fetch("/api/actions-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "service", action: "ui_open_session", session_id: sessionId }),
    }).catch(() => {});

    return () => {
      // Cleanup on unmount or session change
      abortRef.current?.abort("cancelled");
    };
  }, [sessionId, fetchSession]);

  // Auto-poll for new messages when session is active in terminal (not via web).
  // During streaming, poll at a slower rate just for liveness detection so the
  // watchdog can notice when the session process dies.
  useEffect(() => {
    if (isStreaming) {
      const id = setInterval(() => { fetchSession().catch(() => {}); }, 10_000);
      return () => clearInterval(id);
    }
    if (!data?.is_active) return;
    const id = setInterval(() => { fetchSession().catch(() => {}); }, 2000);
    return () => clearInterval(id);
  }, [data?.is_active, isStreaming, fetchSession]);

  // Default folder for new session = current session's project path
  useEffect(() => {
    if (data?.project_path && !newSessionPath) {
      setNewSessionPath(data.project_path);
    }
  }, [data?.project_path, newSessionPath]);

  // Re-fetch when sidebar scan completes (catches inactive sessions that got new messages).
  // Use a ref to avoid tearing down/re-adding the listener on every streaming state change.
  const isStreamingRef = useRef(isStreaming);
  useEffect(() => { isStreamingRef.current = isStreaming; }, [isStreaming]);
  useEffect(() => {
    const handler = () => { if (!isStreamingRef.current) fetchSession().catch(() => {}); };
    window.addEventListener("sessions-scanned", handler);
    return () => window.removeEventListener("sessions-scanned", handler);
  }, [fetchSession]);

  // Track whether user is near bottom in MD view.
  // Key insight: wheel/touchmove events are ONLY fired by user interaction,
  // never by programmatic scrollTo(). This lets us reliably detect when the
  // user scrolls away and avoid fighting them with auto-scroll.
  const mdUserDetachedRef = useRef(false);
  useEffect(() => {
    const el = mdScrollRef.current;
    if (!el) return;
    const THRESHOLD = 150;
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < THRESHOLD;
      mdIsNearBottomRef.current = nearBottom;
      // If user scrolled back to bottom, re-attach
      if (nearBottom) mdUserDetachedRef.current = false;
    };
    // wheel/touch = definitively user-initiated (programmatic scrollTo never fires these)
    const onUserInteraction = () => {
      if (!mdIsNearBottomRef.current) {
        mdUserDetachedRef.current = true;
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onUserInteraction, { passive: true });
    el.addEventListener("touchmove", onUserInteraction, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onUserInteraction);
      el.removeEventListener("touchmove", onUserInteraction);
    };
  }, [data?.session_id, mdView]);

  // Reset MD scroll tracking on session switch
  useEffect(() => {
    mdIsNearBottomRef.current = true;
    mdUserDetachedRef.current = false;
    mdInitialLoadRef.current = null;
  }, [sessionId]);

  // Auto-load MD view when data arrives — load all messages at once (limit=0)
  useEffect(() => {
    if (!data?.session_id || mdContent || mdLoading) return;
    setMdLoading(true);
    fetch(apiUrl(`/api/sessions/${data.session_id}/md`, { limit: "0" }))
      .then(r => r.json())
      .then(json => {
        if (json.markdown) {
          setMdContent(json.markdown);
          setMdHasEarlier(false);
          setMdRenderStart(0);
        }
      })
      .catch(() => {})
      .finally(() => setMdLoading(false));
  }, [data?.session_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load full MD history (user clicks "Load earlier")
  const loadAllMdMessages = useCallback(async () => {
    if (!data?.session_id || mdLoadingEarlier) return;
    setMdLoadingEarlier(true);
    // Save scroll state — earlier messages are prepended, shifting content down
    const scrollEl = mdScrollRef.current;
    const savedScrollTop = scrollEl?.scrollTop ?? 0;
    const savedScrollHeight = scrollEl?.scrollHeight ?? 0;
    try {
      const res = await fetch(apiUrl(`/api/sessions/${data.session_id}/md`, { limit: "0" }));
      const json = await res.json();
      if (json.markdown) {
        setMdContent(json.markdown);
        setMdHasEarlier(false);
        // Compensate for prepended content so user stays at the same spot
        requestAnimationFrame(() => {
          const el = mdScrollRef.current;
          if (!el) return;
          el.scrollTop = savedScrollTop + (el.scrollHeight - savedScrollHeight);
        });
      }
    } catch { /* ignore */ }
    setMdLoadingEarlier(false);
  }, [data?.session_id]); // eslint-disable-line react-hooks/exhaustive-deps


  // Auto-refresh MD content when new messages arrive (active terminal sessions)
  // Debounced: waits 1s after last message-count change before re-fetching
  // to avoid rapid full re-renders during bursts of tool calls.
  const prevMdTotalRef = useRef(0);
  const mdRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!data?.session_id) return;
    const newTotal = data.messages_total ?? 0;
    // On first load, just record the count
    if (prevMdTotalRef.current === 0) {
      prevMdTotalRef.current = newTotal;
      return;
    }
    // Only refresh when message count actually increased and MD is loaded
    if (newTotal > prevMdTotalRef.current && mdContent && mdView) {
      prevMdTotalRef.current = newTotal;
      // Debounce: clear previous timer, wait 1s for burst to settle
      if (mdRefreshTimerRef.current) clearTimeout(mdRefreshTimerRef.current);
      mdRefreshTimerRef.current = setTimeout(() => {
        fetch(apiUrl(`/api/sessions/${data.session_id}/md`, { limit: "0" }))
          .then(r => r.json())
          .then(json => {
            if (json.markdown) {
              setMdContent(json.markdown);
              setMdHasEarlier(false);
              setMdRenderStart(json.render_start ?? 0);
              // No scroll restore needed: MarkdownContent renders each section
              // with a stable key, so React only appends new DOM nodes at the
              // bottom without touching existing ones → scroll stays put.
            }
          })
          .catch(() => {});
      }, 1000);
    } else {
      prevMdTotalRef.current = newTotal;
    }
    return () => {
      if (mdRefreshTimerRef.current) clearTimeout(mdRefreshTimerRef.current);
    };
  }, [data?.messages_total, data?.session_id, mdView]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pre-populate summary/learnings from DB cache (no LLM call needed)
  useEffect(() => {
    if (!data?.metadata) return;
    if (!summary && data.metadata.summary) setSummary(data.metadata.summary);
    if (!learnings && data.metadata.learnings) {
      try {
        setLearnings(typeof data.metadata.learnings === "string"
          ? JSON.parse(data.metadata.learnings) : data.metadata.learnings);
      } catch { /* ignore */ }
    }
  }, [data?.session_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to bottom on initial MD load, or on content update when user hasn't scrolled away.
  // Uses mdUserDetachedRef (set by wheel/touch) instead of just isNearBottom,
  // because smooth scrollTo generates scroll events that pollute isNearBottom.
  useEffect(() => {
    if (!mdContent || !mdScrollRef.current) return;
    const isInitial = mdInitialLoadRef.current !== data?.session_id;
    if (isInitial) {
      mdInitialLoadRef.current = data?.session_id ?? null;
      mdUserDetachedRef.current = false;
      requestAnimationFrame(() => {
        mdScrollRef.current?.scrollTo({ top: mdScrollRef.current!.scrollHeight });
      });
    } else if (!mdUserDetachedRef.current) {
      requestAnimationFrame(() => {
        mdScrollRef.current?.scrollTo({ top: mdScrollRef.current!.scrollHeight, behavior: "smooth" });
      });
    }
  }, [mdContent]); // eslint-disable-line react-hooks/exhaustive-deps


  // Watchdog: detect dead streams and clean up
  useEffect(() => {
    if (!isStreaming) return;

    // Case 1: session went inactive — process is dead, stream should close soon.
    // Short grace period: 3s if no text yet (stream died immediately),
    // 5s if text exists (process died mid-response, give time for stream to flush).
    if (data && !data.is_active) {
      const delay = streamingText ? 5000 : 3000;
      const timer = setTimeout(() => {
        setIsStreaming(false);
        setStreamingText("");
        setStreamStatus(null);
        processingRef.current = false;
        setQueuedMessages([...queueRef.current]);
        fetchSession({ clearExtras: true }).catch(() => {});
      }, delay);
      return () => clearTimeout(timer);
    }

    // Case 2: no SSE events received for 45s — connection likely dropped silently
    // (keepalive pings come every 15s, so 45s = 3 missed pings)
    const check = setInterval(() => {
      const elapsed = Date.now() - lastStreamEventRef.current;
      if (lastStreamEventRef.current > 0 && elapsed > 45_000) {
        setIsStreaming(false);
        setStreamingText("");
        setStreamStatus(null);
        setStreamError("Connection lost — refreshing session data…");
        processingRef.current = false;
        setQueuedMessages([...queueRef.current]);
        fetchSession({ clearExtras: true }).catch(() => {});
      }
    }, 5_000);
    return () => clearInterval(check);
  }, [isStreaming, streamingText, data?.is_active, fetchSession]);

  // Build notification settings from fetched settings
  const notifSettings = useMemo(() => {
    if (!settings) return null;
    return {
      notify_sound: settings.notify_sound === "true",
      notify_browser: settings.notify_browser === "true",
      notify_tab_badge: settings.notify_tab_badge === "true",
    };
  }, [settings]);

  const triggerNotification = useTriggerNotification(notifSettings);

  // Always read from ref so effects with suppressed deps get the latest title
  const dataRef = useRef(data);
  useEffect(() => { dataRef.current = data; }, [data]);
  const getSessionTitle = useCallback(() => {
    const s = dataRef.current?.metadata;
    if (!s) return "Claude";
    return s.custom_name ?? s.generated_title ?? s.first_prompt?.slice(0, 60) ?? "Claude";
  }, []);

  // Clear tab badge when user opens this session
  useEffect(() => {
    clearTabBadge();
  }, [sessionId]);

  // Dynamic browser tab title — show session name instead of generic "Claude Sessions"
  useEffect(() => {
    if (!data) return;
    const title = data.metadata.custom_name
      ?? data.metadata.generated_title
      ?? data.metadata.first_prompt?.slice(0, 60)
      ?? "Session";
    document.title = title;
    return () => { document.title = "Claude Sessions"; };
  }, [data?.session_id, data?.metadata?.custom_name, data?.metadata?.generated_title, data?.metadata?.first_prompt]);

  // Dynamic favicon — per-project icon (GitHub avatar or AI-generated)
  useDynamicFavicon(data?.project_path);

  // Notify when web streaming finishes + start backoff to catch follow-up messages
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isStreaming;
    if (!wasStreaming || isStreaming) return; // only on transition true→false
    if (!streamingText && !data?.messages?.length) return; // nothing happened
    triggerNotification(getSessionTitle());
    startBackoff();
  }, [isStreaming]); // eslint-disable-line react-hooks/exhaustive-deps

  // Start backoff on initial load for recently-modified inactive sessions
  const backoffInitRef = useRef<string | null>(null);
  useEffect(() => {
    if (!data || data.is_active || backoffInitRef.current === data.session_id) return;
    backoffInitRef.current = data.session_id;
    const ageMs = Date.now() - new Date(data.metadata.modified_at).getTime();
    if (ageMs < 20 * 60 * 1000) startBackoff();
  }, [data, startBackoff]);

  // Notify when terminal session goes inactive + start backoff
  const prevIsActiveRef = useRef<boolean | null>(null);
  useEffect(() => {
    const wasActive = prevIsActiveRef.current;
    prevIsActiveRef.current = data?.is_active ?? null;
    if (wasActive === true && data?.is_active === false && !isStreaming) {
      triggerNotification(getSessionTitle());
      startBackoff();
    }
  }, [data?.is_active]); // eslint-disable-line react-hooks/exhaustive-deps

  // Gemini quota exhausted banner
  const isGeminiQuotaError = !!streamError?.startsWith("GEMINI_QUOTA_EXHAUSTED:");
  const geminiExhaustedModel = isGeminiQuotaError ? (streamError!.slice("GEMINI_QUOTA_EXHAUSTED:".length) || data?.metadata?.model || "") : "";
  const [switchingModel, setSwitchingModel] = useState(false);
  const switchToFlash = useCallback(async () => {
    if (!data) return;
    setSwitchingModel(true);
    try {
      await fetch(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "models/gemini-2.5-flash" }),
      });
      setStreamError(null);
      await fetchSession({ clearExtras: true });
    } finally {
      setSwitchingModel(false);
    }
  }, [data, sessionId, fetchSession]);

  // Auto-retry countdown for interrupted sessions
  const [retryCountdown, setRetryCountdown] = useState<number | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryInitRef = useRef<string | null>(null);
  const RETRY_DELAY = 30;

  const cancelRetry = useCallback(() => {
    if (retryTimerRef.current) clearInterval(retryTimerRef.current);
    retryTimerRef.current = null;
    setRetryCountdown(null);
  }, []);

  const isInterrupted = !!(
    data && !data.is_active &&
    data.metadata.last_message_role === "tool_result" &&
    !isStreaming
  );

  useEffect(() => {
    if (!isInterrupted || settings?.auto_retry_on_crash === "false") return;
    // Only start once per session
    if (retryInitRef.current === sessionId) return;
    retryInitRef.current = sessionId;

    setRetryCountdown(RETRY_DELAY);
    let remaining = RETRY_DELAY;
    retryTimerRef.current = setInterval(() => {
      remaining--;
      setRetryCountdown(remaining);
      if (remaining <= 0) {
        cancelRetry();
        // Fire "continue"
        queueRef.current.push("continue");
        setQueuedMessages([...queueRef.current]);
        processQueueRef.current();
      }
    }, 1000);
    return () => cancelRetry();
  }, [isInterrupted, sessionId, settings?.auto_retry_on_crash, cancelRetry]);

  // Cancel retry when user starts typing or streaming starts
  useEffect(() => {
    if (isStreaming && retryCountdown !== null) cancelRetry();
  }, [isStreaming, retryCountdown, cancelRetry]);

  // Stable ref so the retry timer (defined before processQueue) can call it
  const processQueueRef = useRef<() => void>(() => {});

  // Process next message in queue
  const processQueue = useCallback(async () => {
    if (processingRef.current) return;
    const message = queueRef.current.shift();
    if (!message) return;

    setQueuedMessages([...queueRef.current]);
    processingRef.current = true;
    setHasReplied(true);

    // Add user message to extra messages
    const userMsg: ParsedMessage = {
      uuid: `pending-${Date.now()}`,
      type: "user",
      timestamp: new Date().toISOString(),
      content: message,
    };
    setExtraMessages((prev) => [...prev, userMsg]);
    setLastSentText(message);
    setStreamingText("");
    setStreamError(null);
    setStreamStatus(null);
    setStatusHistory([]);
    setIsStreaming(true);
    lastStreamEventRef.current = Date.now();

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(apiUrl(`/api/sessions/${sessionId}/reply`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json();
        setStreamError(err.error || "Failed to send");
        setIsStreaming(false);
        processingRef.current = false;
        processQueue();
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        setStreamError("No response stream");
        setIsStreaming(false);
        processingRef.current = false;
        processQueue();
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            lastStreamEventRef.current = Date.now();
            try {
              const evt = JSON.parse(line.slice(6));
              if (evt.type === "text" || evt.type === "chunk") {
                fullText += evt.text;
                setStreamingText(fullText);
                setStreamStatus(null);
              } else if (evt.type === "status") {
                setStreamStatus(evt.text);
                setStatusHistory(prev => [...prev.slice(-49), evt.text]);
              } else if (evt.type === "error") {
                setStreamError(evt.text);
              } else if (evt.type === "done") {
                if (evt.is_error) {
                  setStreamError(evt.result);
                }
              }
            } catch {
              // ignore parse errors
            }
          } else if (line.startsWith(":")) {
            // SSE comment (keepalive ping) — just update timestamp
            lastStreamEventRef.current = Date.now();
          }
        }
      }

      // Stream finished — bake the assistant response into extraMessages
      if (fullText) {
        const assistantMsg: ParsedMessage = {
          uuid: `reply-${Date.now()}`,
          type: "assistant",
          timestamp: new Date().toISOString(),
          content: fullText,
        };
        setExtraMessages((prev) => [...prev, assistantMsg]);
      }
      setStreamingText("");
      setStreamStatus(null);

      // Only clear extras & error if we got a real response;
      // otherwise keep the user's message and error visible
      if (fullText) {
        setStreamError(null);
        fetchSession({ clearExtras: true }).catch(() => {});
      } else {
        // No response — start backoff poll so session data refreshes eventually
        startBackoff();
      }
    } catch (err) {
      // Don't show error if request was aborted (session switch)
      if ((err instanceof DOMException && err.name === "AbortError") || err === "cancelled") return;
      const detail = err instanceof Error ? err.message : String(err);
      // Bake error into extraMessages so it persists after streaming ends
      const errorMsg: ParsedMessage = {
        uuid: `error-${Date.now()}`,
        type: "assistant",
        timestamp: new Date().toISOString(),
        content: `Failed to send message: ${detail}`,
      };
      setExtraMessages((prev) => [...prev, errorMsg]);
      setStreamError(null);
    } finally {
      setIsStreaming(false);
      setLastSentText(null);
      processingRef.current = false;
      // Schedule next message asynchronously to avoid concurrent streaming
      setTimeout(() => processQueueRef.current(), 0);
    }
  }, [sessionId, fetchSession]);
  processQueueRef.current = processQueue;

  // Auto-find matching message for highlight query, loading earlier batches if needed
  useEffect(() => {
    if (!highlightQuery || !data || loadingEarlier) return;

    const allLoaded = [...earlierMessages, ...data.messages, ...extraMessages];
    const found = allLoaded.find((m) => {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return text.toLowerCase().includes(highlightQuery.toLowerCase());
    });

    if (found) {
      setHighlightId(found.uuid);
    } else if ((earliestLoaded ?? 0) > 0) {
      // Not found yet — load earlier batch
      loadEarlierMessages();
    }
  }, [highlightQuery, data, earlierMessages, extraMessages, earliestLoaded, loadingEarlier, loadEarlierMessages]);

  // Scroll to first search highlight in MD view (MarkdownContent inserts <mark> tags, we scroll the container)
  const didScrollToMdHighlight = useRef<string | null>(null);
  useEffect(() => {
    if (!highlightQuery || !mdContent || !mdView) return;
    if (didScrollToMdHighlight.current === highlightQuery) return;

    // Wait for MarkdownContent to insert <mark> elements (it uses a 100ms setTimeout)
    const timer = setTimeout(() => {
      const container = mdScrollRef.current;
      if (!container) return;
      const mark = container.querySelector("mark[data-search-highlight]");
      if (mark) {
        // Calculate mark's position relative to scroll container
        const markRect = mark.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const scrollOffset = markRect.top - containerRect.top + container.scrollTop - container.clientHeight / 2;
        container.scrollTo({ top: Math.max(0, scrollOffset), behavior: "smooth" });
        didScrollToMdHighlight.current = highlightQuery;
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [highlightQuery, mdContent, mdView]);

  const handleSendDirect = useCallback((message: string) => {
    setContextGuardError(null);
    queueRef.current.push(message);
    setQueuedMessages([...queueRef.current]);
    processQueue();
  }, [processQueue]);

  const handleSend = (message: string) => {
    // Warn once per page load if skip-permissions is off
    if (!skipPermsShown && settings?.dangerously_skip_permissions !== "true") {
      setSkipPermsDialog({ message });
      setSkipPermsShown(true);
      return;
    }

    if (settings?.context_guard_enabled === "true" && data) {
      const minMessages = parseInt(settings.context_guard_min_messages || "6", 10);
      const messageCount = data.metadata?.message_count ?? 0;

      if (messageCount >= minMessages) {
        const result = checkContextGuard(
          message,
          data.metadata?.generated_title ?? null,
          data.metadata?.first_prompt ?? null,
        );

        if (!result.skipped) {
          const blockThreshold = parseInt(settings.context_guard_block_threshold || "90", 10);
          const warnThreshold = parseInt(settings.context_guard_warn_threshold || "80", 10);

          if (result.score >= blockThreshold) {
            setContextGuardError(
              `This message appears off-topic for this session (${result.score}% confidence). Start a new session instead.`
            );
            return;
          }

          if (result.score >= warnThreshold) {
            setContextGuardDialog({ open: true, message, score: result.score });
            return;
          }
        }
      }
    }

    handleSendDirect(message);
  };

  const insertAtNewSessionCursor = (text: string) => {
    const textarea = newSessionInputRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = newSessionMessage.slice(0, start);
    const after = newSessionMessage.slice(end);
    const separator = before && !before.endsWith("\n") ? "\n" : "";
    const newVal = before + separator + text + after;
    setNewSessionMessage(newVal);
    requestAnimationFrame(() => {
      const pos = start + separator.length + text.length;
      textarea.setSelectionRange(pos, pos);
      textarea.focus();
    });
  };

  const uploadNewSessionFiles = async (files: File[]) => {
    for (const file of files) {
      const fd = new FormData();
      fd.append("file", file);
      try {
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const data = await res.json();
        insertAtNewSessionCursor(data.path || file.name);
      } catch {
        insertAtNewSessionCursor(file.name);
      }
    }
  };

  const handleNewSessionDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    newDragCounterRef.current = 0;
    setNewSessionDragging(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) uploadNewSessionFiles(files);
  };

  const handleNewSessionDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    newDragCounterRef.current++;
    setNewSessionDragging(true);
  };

  const handleNewSessionDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    newDragCounterRef.current--;
    if (newDragCounterRef.current <= 0) {
      newDragCounterRef.current = 0;
      setNewSessionDragging(false);
    }
  };

  const handleNewSessionDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  };

  const handleNewSessionFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) await uploadNewSessionFiles(files);
    if (newFileInputRef.current) newFileInputRef.current.value = "";
  };

  const handleNewSessionAutodetect = async (overrideMessage?: string) => {
    const msg = overrideMessage || newSessionMessage;
    const firstPath = await newAutodetect.detect(msg);
    if (firstPath) setNewSessionPath(firstPath);
  };

  const handleSubmitIssue = async () => {
    if (!issueCategory || !issueDescription.trim() || isSubmittingIssue) return;
    setIsSubmittingIssue(true);
    try {
      const res = await fetch("/api/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: issueCategory,
          description: issueDescription.trim(),
          session_id: data?.session_id,
          project_path: data?.project_path,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error || "Failed to submit");
      }
      toast.success("Issue submitted — thank you!");
      setIssueCategory(null);
      setIssueDescription("");
      setReplyMode("reply");
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsSubmittingIssue(false);
    }
  };

  const handleStartNewSession = async (overrideMessage?: string) => {
    const msg = (overrideMessage || newSessionMessage).trim();
    if (!msg || !newSessionPath || startingNewSession) return;
    setStartingNewSession(true);
    setError(null);

    try {
      let fullMessage = msg;

      // Optionally prepend smart context from previous session
      if (includeSummary) {
        try {
          const ctxRes = await fetch(apiUrl(`/api/sessions/${sessionId}/context`), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question: msg }),
          });
          if (ctxRes.ok) {
            const ctxData = await ctxRes.json();
            if (ctxData.context && ctxData.context.length > 20) {
              fullMessage = `${msg}\n\n<context>\nRelevant context from previous session:\n${ctxData.context}\n</context>`;
            }
          }
        } catch { /* non-critical — send without context */ }
      }

      const startUrl = compute.nodeId
        ? `/api/sessions/start?node=${encodeURIComponent(compute.nodeId)}`
        : "/api/sessions/start";
      const res = await fetch(startUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: newSessionPath, message: fullMessage, previous_session_id: sessionId, ...(newSessionModel && { model: newSessionModel }), ...(newSessionAgent !== "claude" && { agent: newSessionAgent }) }),
      });

      if (!res.ok) throw new Error("Failed to start session");

      // Read SSE stream to completion but stay on current page
      if (res.body) {
        const reader = res.body.getReader();
        const readStream = async () => {
          try {
            while (true) {
              const { done } = await reader.read();
              if (done) break;
            }
          } catch { /* stream closed */ }
        };
        readStream();
      }
      setNewSessionMessage("");
      if (overrideMessage) replyInputRef.current?.setText("");
      setStartingNewSession(false);
      toast.success("Session started — will appear in list shortly");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start new session");
      setStartingNewSession(false);
    }
  };

  const removeQueued = (index: number) => {
    queueRef.current.splice(index, 1);
    setQueuedMessages([...queueRef.current]);
  };

  const cancelStreaming = useCallback(() => {
    abortRef.current?.abort("cancelled");
    setIsStreaming(false);
    setStreamingText("");
    setStreamError(null);
    setStreamStatus(null);
    setLastSentText(null);
    processingRef.current = false;
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === "TEXTAREA" || tag === "INPUT";

      // Escape → cancel streaming (works everywhere)
      if (e.key === "Escape" && isStreaming) {
        e.preventDefault();
        cancelStreaming();
        return;
      }

      // Cmd/Ctrl+L → focus reply input
      if ((e.metaKey || e.ctrlKey) && e.key === "l") {
        e.preventDefault();
        replyInputRef.current?.focus();
        return;
      }

      // Cmd/Ctrl+K → clear visible extras (only when not in input)
      if ((e.metaKey || e.ctrlKey) && e.key === "k" && !isInput) {
        e.preventDefault();
        setExtraMessages([]);
        setEarlierMessages([]);
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isStreaming, cancelStreaming]);

  // Redirect to session list if session not found (must be before any conditional returns)
  useEffect(() => {
    if (!loading && (error || !data)) {
      router.replace("/claude-sessions");
    }
  }, [loading, error, data, router]);

  if (loading || error || !data) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Use last assistant message's usage — this reflects the actual current context window size.
  // Cumulative total_input_tokens is wrong: each turn re-sends full context so it grows as N².
  // Must include cache_read + cache_creation — with prompt caching most tokens are there.
  // Iterate backwards to avoid copying the array.
  let lastUsage: typeof data.messages[0]["usage"] | undefined;
  for (let i = data.messages.length - 1; i >= 0; i--) {
    const m = data.messages[i];
    if (m.type === "assistant" && m.usage) { lastUsage = m.usage; break; }
  }
  const totalTokens = lastUsage
    ? (lastUsage.input_tokens || 0)
      + (lastUsage.cache_read_input_tokens || 0)
      + (lastUsage.cache_creation_input_tokens || 0)
      + (lastUsage.output_tokens || 0)
    : 0;


  const killTerminal = async () => {
    try {
      await fetch(apiUrl(`/api/sessions/${sessionId}/kill`), { method: "POST" });
      setTerminalKilled(true);
    } catch {
      // ignore
    }
  };

  const handleShare = async () => {
    setShareState("loading");
    try {
      const res = await fetch(apiUrl(`/api/sessions/${sessionId}/share`), { method: "POST" });
      const json = await res.json();
      if (json.url) {
        setShareUrl(json.url);
        setShareState("done");
      } else {
        setShareState("idle");
        alert(`Share failed: ${json.error ?? "unknown error"}`);
      }
    } catch {
      setShareState("idle");
    }
  };

  const copyShareUrl = () => {
    if (!shareUrl) return;
    navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const openInTerminal = async () => {
    try {
      const res = await fetch(apiUrl(`/api/sessions/${sessionId}/open`), {
        method: "POST",
      });
      if (!res.ok) {
        const err = await res.json();
        alert(`Failed to open: ${err.error}`);
      }
    } catch {
      alert("Failed to open terminal");
    }
  };

  const focusTerminal = async () => {
    setFocusError(null);
    setFocusOk(false);
    try {
      const res = await fetch(apiUrl(`/api/sessions/${sessionId}/focus`), { method: "POST" });
      if (!res.ok) {
        const err = await res.json();
        setFocusError(err.error ?? "Failed to focus terminal");
      } else {
        setFocusOk(true);
        setTimeout(() => setFocusOk(false), 2000);
      }
    } catch {
      setFocusError("Failed to focus terminal");
    }
  };

  // Combine: earlier (paginated) + server messages + extra (optimistic/streaming)
  const allMessages = [...earlierMessages, ...data.messages, ...extraMessages];
  const hasEarlier = (earliestLoaded ?? 0) > 0;

  return (
    <>
      {/* Session header — single line: status + title */}
      {(() => {
        let activityStatus = getActivityStatus({ is_active: data.is_active, modified_at: data.metadata.modified_at, last_message_role: data.metadata.last_message_role, has_result: data.has_result });
        // If JSONL was written to recently and process is alive, Claude is actively working
        // (not just waiting at prompt — the "terminal-open" heuristic is wrong mid-tool-execution)
        if (data.is_active && data.file_age_ms != null && data.file_age_ms < 30_000 && activityStatus === "terminal-open") {
          activityStatus = "active";
        }
        const isRunning = activityStatus === "active";
        const isWaiting = activityStatus === "waiting";
        const isInterrupted = activityStatus === "interrupted";
        return (
          <div className={`border-b px-5 py-2 flex items-center gap-3 min-h-[40px] shrink-0 transition-colors duration-500 ${
            isRunning ? "border-green-500/30 bg-green-500/5" :
            isInterrupted ? "border-orange-500/30 bg-orange-500/5" :
            isWaiting ? "border-blue-500/30 bg-blue-500/5" :
            "border-border"
          }`}>
            <StatusBadge status={activityStatus} />
            <h2 className="text-sm font-medium flex-1 min-w-0 line-clamp-2">
              {data.metadata.custom_name ||
              data.metadata.first_prompt?.slice(0, 200) ||
              data.session_id.slice(0, 8)}
            </h2>
          </div>
        );
      })()}

      {/* Two-column layout: messages left, reply panel right */}
      <div className="flex-1 flex min-h-0">
        {/* ── Left: Messages ──────────────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* ── Summary + Learnings triggers — hidden, moved to bottom of MD ── */}
          <div className="shrink-0 border-b border-border/30 hidden">
            <div className="flex items-center gap-3 px-5 py-1.5">
              <button
                onClick={async () => {
                  if (summaryOpen) { setSummaryOpen(false); return; }
                  setSummaryOpen(true);
                  if (summary) return;
                  setSummaryLoading(true);
                  setSummaryError(null);
                  try {
                    const res = await fetch(apiUrl(`/api/sessions/${data.session_id}/summary`), { method: "POST" });
                    const json = await res.json();
                    if (json.error) setSummaryError(json.error);
                    else setSummary(json.summary);
                  } catch (e) {
                    setSummaryError(e instanceof Error ? e.message : "Failed");
                  } finally { setSummaryLoading(false); }
                }}
                className={`flex items-center gap-1.5 text-[11px] py-0.5 rounded transition-all duration-300 ${
                  summaryLoading
                    ? "text-blue-400 animate-pulse"
                    : summary
                      ? "text-green-500/60 hover:text-green-500"
                      : summaryOpen
                        ? "text-foreground"
                        : "text-muted-foreground/40 hover:text-muted-foreground"
                }`}
                title="Generate session summary"
              >
                <ScrollText className="h-3 w-3" />
                Summary
              </button>
              <button
                onClick={async () => {
                  if (learningsOpen) { setLearningsOpen(false); return; }
                  setLearningsOpen(true);
                  if (learnings) return;
                  setLearningsLoading(true);
                  setLearningsError(null);
                  try {
                    const res = await fetch(apiUrl(`/api/sessions/${data.session_id}/learnings`), { method: "POST" });
                    const json = await res.json();
                    if (json.error) setLearningsError(json.error);
                    else setLearnings(json.learnings);
                  } catch (e) {
                    setLearningsError(e instanceof Error ? e.message : "Failed");
                  } finally { setLearningsLoading(false); }
                }}
                className={`flex items-center gap-1.5 text-[11px] py-0.5 rounded transition-all duration-300 ${
                  learningsLoading
                    ? "text-blue-400 animate-pulse"
                    : learnings
                      ? "text-green-500/60 hover:text-green-500"
                      : learningsOpen
                        ? "text-foreground"
                        : "text-muted-foreground/40 hover:text-muted-foreground"
                }`}
                title="Extract session learnings"
              >
                <Lightbulb className="h-3 w-3" />
                Learnings
              </button>
            </div>

            {/* Summary panel — expands below trigger */}
            {summaryOpen && (
              <div className="border-t border-border/20 bg-muted/10 px-5 py-3 max-h-[40vh] overflow-y-auto">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider">Summary</span>
                  <button
                    onClick={() => setSummaryOpen(false)}
                    className="text-[10px] text-muted-foreground/40 hover:text-muted-foreground flex items-center gap-1 transition-colors"
                  >
                    <ChevronsDownUp className="h-3 w-3" />
                    Collapse
                  </button>
                </div>
                {summaryLoading && (
                  <div className="flex items-center gap-2 py-4 justify-center text-[11px] text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin text-blue-400" />
                    <span className="text-blue-400/70">Generating summary…</span>
                  </div>
                )}
                {summaryError && <div className="text-[11px] text-red-500 py-1">{summaryError}</div>}
                {summary && <MarkdownContent content={summary} projectPath={data?.project_path} compact />}
              </div>
            )}

            {/* Learnings panel — expands below trigger */}
            {learningsOpen && (
              <div className="border-t border-border/20 bg-muted/10 px-5 py-3 max-h-[40vh] overflow-y-auto">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider">Learnings</span>
                  <button
                    onClick={() => setLearningsOpen(false)}
                    className="text-[10px] text-muted-foreground/40 hover:text-muted-foreground flex items-center gap-1 transition-colors"
                  >
                    <ChevronsDownUp className="h-3 w-3" />
                    Collapse
                  </button>
                </div>
                {learningsLoading && (
                  <div className="flex items-center gap-2 py-4 justify-center text-[11px] text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin text-blue-400" />
                    <span className="text-blue-400/70">Extracting learnings…</span>
                  </div>
                )}
                {learningsError && (
                  <div className="text-[11px] text-red-500 py-2 space-y-1">
                    <div>{learningsError}</div>
                    <button
                      onClick={() => {
                        setLearningsError(null);
                        setLearningsLoading(true);
                        fetch(`/api/sessions/${data.session_id}/learnings?refresh=1`, { method: "POST" })
                          .then(r => r.json())
                          .then(json => {
                            if (json.error) setLearningsError(json.error + (json.raw ? `\n\nRaw: ${json.raw.slice(0, 300)}...` : ""));
                            else setLearnings(json.learnings);
                          })
                          .catch(e => setLearningsError(e.message))
                          .finally(() => setLearningsLoading(false));
                      }}
                      className="underline underline-offset-2 hover:text-red-400"
                    >
                      Retry with refresh
                    </button>
                  </div>
                )}
                {learnings && (() => {
                  const l = learnings as Record<string, string | string[]>;
                  const categories = [
                    { key: "summary", label: "Summary", single: true },
                    { key: "discoveries", label: "Discoveries", single: false },
                    { key: "friction_loops", label: "Friction / Loops", single: false },
                    { key: "claude_md_rules", label: "CLAUDE.md Rules", single: false },
                    { key: "patterns", label: "Patterns", single: false },
                    { key: "bugs_fixed", label: "Bugs Fixed", single: false },
                    { key: "tools_learned", label: "Tools Learned", single: false },
                    { key: "preferences", label: "Preferences", single: false },
                    { key: "gotchas", label: "Gotchas", single: false },
                    { key: "prompt_coaching", label: "Prompt Coaching", single: false },
                  ];
                  return (
                    <div className="space-y-2.5">
                      {categories.map(({ key, label, single }) => {
                        const val = l[key];
                        if (!val || (Array.isArray(val) && val.length === 0)) return null;
                        return (
                          <div key={key}>
                            <div className="text-[9px] font-medium text-muted-foreground/50 uppercase tracking-wider mb-0.5">{label}</div>
                            {single ? (
                              <p className="text-[11px] text-foreground/80 leading-relaxed">{val as string}</p>
                            ) : (
                              <ul className="space-y-0.5">
                                {(val as string[]).map((item, i) => (
                                  <li key={i} className="text-[11px] text-foreground/80 leading-relaxed flex gap-1.5">
                                    <span className="text-muted-foreground/30 shrink-0">•</span>
                                    <span
                                      className="cursor-pointer hover:bg-muted/50 rounded px-0.5 -mx-0.5 transition-colors"
                                      onClick={() => navigator.clipboard.writeText(item)}
                                      title="Click to copy"
                                    >{item}</span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
            )}
          </div>

          {/* MD view (default) or bubble messages */}
          {mdView ? (
            <div className="flex-1 min-h-0 overflow-y-auto relative" ref={mdScrollRef}>
              {mdLoading ? (
                <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <span className="text-sm">Loading session…</span>
                </div>
              ) : mdContent ? (
                <div className="max-w-4xl mx-auto px-6 py-6">
                  <MarkdownContent content={mdContent} projectPath={data.project_path} compact folded={folded} highlightQuery={highlightQuery ?? undefined} />

                  {/* ── Live activity indicator ── */}
                  {data.is_active && (data.metadata.last_message_role !== "assistant" || (data.file_age_ms != null && data.file_age_ms < 30_000)) && (
                    <div className="my-4 flex items-center gap-2 text-[12px] text-green-600 dark:text-green-400 animate-pulse">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span className="font-medium">Claude is working…</span>
                      {streamingText && (
                        <span className="text-muted-foreground font-normal truncate max-w-[400px]">
                          {streamingText.split('\n').pop()?.slice(0, 80)}
                        </span>
                      )}
                    </div>
                  )}

                  {/* ── Summary & Learnings — collapsible at bottom ── */}
                  <div className="mt-6 space-y-2 pb-4">
                    {/* Summary */}
                    <div className="border border-border/30 rounded-lg overflow-hidden">
                      <button
                        onClick={async () => {
                          if (summaryOpen) { setSummaryOpen(false); return; }
                          setSummaryOpen(true);
                          if (summary) return;
                          setSummaryLoading(true);
                          setSummaryError(null);
                          try {
                            const res = await fetch(apiUrl(`/api/sessions/${data.session_id}/summary`), { method: "POST" });
                            const json = await res.json();
                            if (json.error) setSummaryError(json.error);
                            else setSummary(json.summary);
                          } catch (e) {
                            setSummaryError(e instanceof Error ? e.message : "Failed");
                          } finally { setSummaryLoading(false); }
                        }}
                        className="w-full flex items-center gap-2 px-4 py-2 text-[12px] text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <span className={summaryOpen ? "rotate-90 transition-transform" : "transition-transform"}>▶</span>
                        <ScrollText className="h-3.5 w-3.5" />
                        <span className="font-medium">Summary</span>
                        {summary && <span className="text-[10px] text-green-500 font-medium ml-1">ready</span>}
                        {summaryLoading && <Loader2 className="h-3 w-3 animate-spin text-blue-400 ml-1" />}
                      </button>
                      {summaryOpen && (
                        <div className="px-4 pb-3 border-t border-border/20">
                          {summaryError && <div className="text-[11px] text-red-500 py-2">{summaryError}</div>}
                          {summary && (
                            <div className="pt-2 relative group/summary">
                              <button
                                onClick={() => { navigator.clipboard.writeText(summary); toast.success("Summary copied"); }}
                                className="absolute top-2 right-0 p-1 rounded opacity-0 group-hover/summary:opacity-100 text-muted-foreground/40 hover:text-muted-foreground transition-opacity"
                                title="Copy summary"
                              >
                                <Copy className="h-3.5 w-3.5" />
                              </button>
                              <MarkdownContent content={summary} projectPath={data?.project_path} compact />
                            </div>
                          )}
                          {!summary && !summaryLoading && !summaryError && <div className="text-[11px] text-muted-foreground py-2">Click to generate…</div>}
                        </div>
                      )}
                    </div>

                    {/* Learnings */}
                    <div className="border border-border/30 rounded-lg overflow-hidden">
                      <button
                        onClick={async () => {
                          if (learningsOpen) { setLearningsOpen(false); return; }
                          setLearningsOpen(true);
                          if (learnings) return;
                          setLearningsLoading(true);
                          setLearningsError(null);
                          try {
                            const res = await fetch(apiUrl(`/api/sessions/${data.session_id}/learnings`), { method: "POST" });
                            const json = await res.json();
                            if (json.error) setLearningsError(json.error);
                            else setLearnings(json.learnings);
                          } catch (e) {
                            setLearningsError(e instanceof Error ? e.message : "Failed");
                          } finally { setLearningsLoading(false); }
                        }}
                        className="w-full flex items-center gap-2 px-4 py-2 text-[12px] text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <span className={learningsOpen ? "rotate-90 transition-transform" : "transition-transform"}>▶</span>
                        <Lightbulb className="h-3.5 w-3.5" />
                        <span className="font-medium">Learnings</span>
                        {learnings && <span className="text-[10px] text-green-500 font-medium ml-1">ready</span>}
                        {learningsLoading && <Loader2 className="h-3 w-3 animate-spin text-blue-400 ml-1" />}
                      </button>
                      {learningsOpen && (
                        <div className="px-4 pb-3 border-t border-border/20">
                          {learningsError && (
                            <div className="text-[11px] text-red-500 py-2 space-y-1">
                              <div>{learningsError}</div>
                              <button
                                onClick={() => {
                                  setLearningsError(null);
                                  setLearningsLoading(true);
                                  fetch(`/api/sessions/${data.session_id}/learnings?refresh=1`, { method: "POST" })
                                    .then(r => r.json())
                                    .then(json => {
                                      if (json.error) setLearningsError(json.error + (json.raw ? `\n\nRaw: ${json.raw.slice(0, 300)}...` : ""));
                                      else setLearnings(json.learnings);
                                    })
                                    .catch(e => setLearningsError(e.message))
                                    .finally(() => setLearningsLoading(false));
                                }}
                                className="underline underline-offset-2 hover:text-red-400"
                              >
                                Retry with refresh
                              </button>
                            </div>
                          )}
                          {learnings && (() => {
                            const l = learnings as Record<string, string | string[]>;
                            const entries = Object.entries(l).filter(([, v]) => (Array.isArray(v) ? v.length > 0 : !!v));
                            return (
                              <div className="pt-2 space-y-2 relative group/learnings">
                                <button
                                  onClick={() => { navigator.clipboard.writeText(JSON.stringify(learnings, null, 2)); toast.success("Learnings copied"); }}
                                  className="absolute top-2 right-0 p-1 rounded opacity-0 group-hover/learnings:opacity-100 text-muted-foreground/40 hover:text-muted-foreground transition-opacity"
                                  title="Copy learnings"
                                >
                                  <Copy className="h-3.5 w-3.5" />
                                </button>
                                {entries.map(([key, value]) => (
                                  <div key={key}>
                                    <div className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider mb-1">{key.replace(/_/g, " ")}</div>
                                    {typeof value === "string" ? (
                                      <p className="text-[12px] text-foreground/80">{value}</p>
                                    ) : (
                                      <ul className="list-disc pl-4 space-y-0.5">
                                        {(value as string[]).map((item, i) => (
                                          <li key={i} className="text-[12px] text-foreground/80">{item}</li>
                                        ))}
                                      </ul>
                                    )}
                                  </div>
                                ))}
                              </div>
                            );
                          })()}
                          {!learnings && !learningsLoading && !learningsError && <div className="text-[11px] text-muted-foreground py-2">Click to generate…</div>}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
          <MessageView
            messages={allMessages}
            sessionId={data.session_id}
            streamingText={streamingText}
            isStreaming={isStreaming}
            streamError={streamError}
            highlightId={highlightId}
            highlightQuery={highlightQuery ?? undefined}
            folded={folded}
            projectPath={data.project_path}
            onLoadEarlier={hasEarlier ? loadEarlierMessages : undefined}
            loadingEarlier={loadingEarlier}
          />
          )}

          {/* Permission requests from Claude CLI */}
          {pendingPermissions.length > 0 && (
            <div className="border-t border-amber-500/30 bg-amber-500/5 px-4 py-2.5 space-y-2 shrink-0">
              {pendingPermissions.map((perm) => (
                <div key={perm.id} className="flex items-start gap-3">
                  <ShieldCheck className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-foreground">
                      Claude wants to use <span className="font-mono text-amber-600 dark:text-amber-400">{perm.toolName}</span>
                    </div>
                    {perm.toolInput && Object.keys(perm.toolInput).length > 0 && (
                      <div className="text-[11px] text-muted-foreground mt-0.5 font-mono truncate max-w-full">
                        {perm.toolName === "Bash" && perm.toolInput.command
                          ? String(perm.toolInput.command).slice(0, 120)
                          : perm.toolName === "Edit" || perm.toolName === "Write"
                            ? String(perm.toolInput.file_path || "")
                            : JSON.stringify(perm.toolInput).slice(0, 120)}
                      </div>
                    )}
                    <div className="text-[10px] text-muted-foreground/60 mt-0.5">
                      {perm.cwd?.split(/[\\/]/).pop()}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2.5 text-[11px] border-green-600/40 text-green-600 hover:bg-green-600 hover:text-white"
                      onClick={() => handlePermissionDecide(perm.id, "allow")}
                    >
                      Allow
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2.5 text-[11px] border-red-600/40 text-red-500 hover:bg-red-600 hover:text-white"
                      onClick={() => handlePermissionDecide(perm.id, "deny")}
                    >
                      Deny
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Queued messages waiting to be sent */}
          {queuedMessages.length > 0 && (
            <div className="border-t border-border px-4 py-2 space-y-1.5 shrink-0 bg-muted/20">
              {queuedMessages.map((msg, i) => (
                <div key={i} className="flex items-start gap-2 group">
                  <div className="flex-1 min-w-0 text-xs text-muted-foreground bg-muted/40 rounded px-2.5 py-1.5 border border-border/50 line-clamp-2">
                    {msg}
                  </div>
                  <button
                    onClick={() => removeQueued(i)}
                    className="shrink-0 mt-1 text-muted-foreground/40 hover:text-destructive transition-colors opacity-0 group-hover:opacity-100"
                    title="Remove from queue"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
              <div className="text-[10px] text-muted-foreground/50">
                {queuedMessages.length} queued
              </div>
            </div>
          )}

        </div>

        {/* ── Right: Reply panel ──────────────────────────────────────────────── */}
        {!rightPanelOpen && (
          <div className="shrink-0 border-l border-border flex flex-col items-center py-2 bg-muted/30 w-10">
            <button
              onClick={() => setRightPanelOpen(true)}
              className="p-1.5 rounded hover:bg-muted text-muted-foreground/60 hover:text-foreground transition-colors"
              title="Show panel"
            >
              <PanelRight className="h-4 w-4" />
            </button>
          </div>
        )}
        <div className={`shrink-0 border-l border-border flex flex-col bg-muted/30 transition-[width] duration-200 ease-in-out overflow-hidden ${rightPanelOpen ? "w-96" : "w-0 border-l-0"}`}>
          {/* Panel header with collapse button */}
          <div className="flex items-center justify-end px-2 pt-1.5 shrink-0">
            <button
              onClick={() => setRightPanelOpen(false)}
              className="p-1 rounded hover:bg-muted text-muted-foreground/40 hover:text-foreground transition-colors"
              title="Hide panel"
            >
              <PanelRightClose className="h-3.5 w-3.5" />
            </button>
          </div>
          {/* Scrollable info section */}
          <div className="flex-1 min-h-0 overflow-y-auto px-4 pt-0 space-y-2">
            {/* Session metadata */}
            <div className="text-xs text-muted-foreground space-y-1">
              <div className="flex items-center gap-2">
                <span className="truncate">{data.project_path.split(/[\\/]/).pop()}</span>
                {data.metadata.git_branch && data.metadata.git_branch !== "HEAD" && (
                  <span className="flex items-center gap-1 shrink-0">
                    <GitBranch className="h-3 w-3" />
                    {data.metadata.git_branch}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <span className="flex items-center gap-1">
                  <Hash className="h-3 w-3" />
                  {data.messages_total ?? data.metadata.message_count} messages
                </span>
                {data.metadata.model && (
                  <span className="text-xs text-muted-foreground">{data.metadata.model}</span>
                )}
                {totalTokens > 0 && <ContextBar tokens={totalTokens} />}
              </div>
            </div>

            {/* Terminal group: Open / Focus / Kill */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 text-xs h-7"
                onClick={openInTerminal}
              >
                <Terminal className="h-3.5 w-3.5" />
                Open Terminal
              </Button>
              {data.is_active && (
                <>
                  <Button size="sm" variant="ghost" className="gap-1 text-xs h-7" onClick={focusTerminal} title="Bring terminal into focus">
                    <Crosshair className="h-3.5 w-3.5" />
                    {focusOk ? "Focused!" : "Focus"}
                  </Button>
                  {!terminalKilled && (
                    <Button size="sm" variant="ghost" className="gap-1 text-xs h-7 text-destructive/60 hover:text-destructive" onClick={killTerminal} title="Kill terminal session">
                      <X className="h-3.5 w-3.5" />
                      Kill
                    </Button>
                  )}
                </>
              )}
              {focusError && (
                <span className="text-[10px] text-amber-600 dark:text-amber-400">{focusError}</span>
              )}
            </div>


            {/* Actions: fold / download / share */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <Button
                size="sm"
                variant={folded ? "secondary" : "ghost"}
                className="gap-1 text-xs h-7"
                onClick={() => setFolded((v) => !v)}
                title={folded ? "Unfold — show all messages" : "Fold — collapse Claude messages"}
              >
                {folded ? <ChevronsUpDown className="h-3.5 w-3.5" /> : <ChevronsDownUp className="h-3.5 w-3.5" />}
                {folded ? "Unfold" : "Fold"}
              </Button>
              <a
                href={`/api/sessions/${data.session_id}/export?format=text`}
                download={`${data.session_id.slice(0, 8)}-messages.txt`}
                title="Download messages as readable text"
                className="inline-flex items-center gap-1 h-7 px-2 text-xs rounded-md hover:bg-accent hover:text-accent-foreground transition-colors"
              >
                <Download className="h-3.5 w-3.5" />
                Log
              </a>
              <Button
                size="sm"
                variant={!mdView ? "secondary" : "ghost"}
                className="gap-1 text-xs h-7"
                onClick={() => setMdView(v => !v)}
                title={mdView ? "Switch to bubble view" : "Switch to Markdown view"}
              >
                {mdView ? <MessageSquare className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />}
                {mdView ? "Bubbles" : "MD"}
              </Button>
              {shareState === "done" && shareUrl ? (
                <div className="flex items-center gap-1">
                  <a
                    href={shareUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 max-w-[140px] truncate"
                  >
                    {shareUrl.replace(/^https?:\/\//, "")}
                  </a>
                  <Button size="icon" variant="ghost" className="h-6 w-6" onClick={copyShareUrl} title="Copy link">
                    {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                  </Button>
                </div>
              ) : (
                <Button size="sm" variant="ghost" className="gap-1 text-xs h-7" onClick={handleShare} disabled={shareState === "loading"} title="Share session">
                  {shareState === "loading" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Share2 className="h-3.5 w-3.5" />}
                  Share
                </Button>
              )}
            </div>

            {/* Status alerts: crashed > streaming > terminal active */}
            {isInterrupted && !isStreaming ? (
              <div className="flex items-start gap-2 p-2.5 text-xs rounded-lg border border-orange-500/30 bg-orange-500/5 text-orange-700 dark:text-orange-400">
                <span className="w-2 h-2 rounded-full bg-orange-500 animate-pulse shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <span>Crashed mid-execution</span>
                  {retryCountdown !== null && (
                    <span className="block mt-0.5 opacity-80">Auto-retry in <strong>{retryCountdown}s</strong></span>
                  )}
                  <div className="flex gap-1.5 mt-1.5">
                    {retryCountdown !== null ? (
                      <Button size="sm" variant="ghost" className="h-5 text-[11px] px-1.5 gap-0.5 text-orange-700 dark:text-orange-400 hover:bg-orange-500/10" onClick={cancelRetry}>
                        <X className="h-2.5 w-2.5" /> Cancel
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" className="h-5 text-[11px] px-1.5 text-orange-700 dark:text-orange-400 hover:bg-orange-500/10" onClick={() => { queueRef.current.push("continue"); setQueuedMessages([...queueRef.current]); processQueue(); }}>
                        Retry now
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ) : isStreaming ? (
              <div className="rounded-lg border border-orange-500/30 bg-orange-500/5 text-orange-600 dark:text-orange-400 overflow-hidden">
                {/* current status line */}
                <div className="flex items-center gap-2 p-2.5 text-xs">
                  <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                  <span className="flex-1 truncate">{streamStatus || "Thinking…"}</span>
                  <button onClick={cancelStreaming} className="text-muted-foreground/60 hover:text-foreground transition-colors" title="Stop (Esc)">
                    <X className="h-3 w-3" />
                  </button>
                </div>
                {/* history log — up to 50 past status events */}
                {statusHistory.length > 1 && (
                  <div className="border-t border-orange-500/20 px-2.5 pb-2 max-h-40 overflow-y-auto flex flex-col-reverse">
                    {[...statusHistory].reverse().slice(1).map((s, i) => (
                      <div key={i} className="text-[10px] text-orange-500/60 dark:text-orange-400/50 py-0.5 truncate font-mono">{s}</div>
                    ))}
                  </div>
                )}
              </div>
            ) : data.is_active && !queuedMessages.length ? (
              <div className="flex items-center gap-2 p-2.5 text-xs rounded-lg border border-border bg-muted/30 text-muted-foreground">
                {(data.metadata.last_message_role !== "assistant" || hasReplied || (data.file_age_ms != null && data.file_age_ms < 30_000))
                  ? <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                  : <Terminal className="h-3 w-3 shrink-0 opacity-60" />
                }
                <span>
                  {(data.file_age_ms != null && data.file_age_ms < 30_000)
                    ? "Claude is working…"
                    : data.metadata.last_message_role !== "assistant"
                      ? "Claude is working…"
                      : hasReplied
                        ? "Waiting for Claude…"
                        : "Waiting for reply"}
                </span>
              </div>
            ) : null}

            {/* Gemini quota exhausted banner */}
            {isGeminiQuotaError && (
              <div className="flex items-start gap-2.5 p-2.5 text-xs rounded-lg border border-yellow-500/40 bg-yellow-500/8 text-yellow-700 dark:text-yellow-400">
                <Zap className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium">Gemini quota exhausted</div>
                  {geminiExhaustedModel && (
                    <div className="opacity-70 mt-0.5 font-mono">{geminiExhaustedModel}</div>
                  )}
                  <div className="opacity-70 mt-0.5">All API keys hit their daily limit for this model.</div>
                  <div className="flex gap-1.5 mt-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[11px] px-2 border-yellow-500/40 text-yellow-700 dark:text-yellow-400 hover:bg-yellow-500/10"
                      onClick={switchToFlash}
                      disabled={switchingModel}
                    >
                      {switchingModel ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Zap className="h-3 w-3 mr-1" />}
                      Switch to gemini-2.5-flash
                    </Button>
                  </div>
                </div>
                <button className="text-yellow-500/60 hover:text-yellow-500 shrink-0" onClick={() => setStreamError(null)}>
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}

            {/* Context Guard error */}
            {contextGuardError && (
              <div className="flex items-start gap-2 p-2.5 text-xs text-red-500 bg-red-500/10 border border-red-500/20 rounded-lg">
                <ShieldAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span className="flex-1">{contextGuardError}</span>
                <button className="text-red-400 hover:text-red-300 shrink-0" onClick={() => setContextGuardError(null)}>
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}

            {/* Process vitals */}
            {data.is_active && data.process_vitals && (
              <div className="font-mono text-[10px] text-muted-foreground/70 space-y-1">
                <div className="flex items-center gap-2">
                  <span
                    className={data.process_vitals.cpu_percent > 5 ? "text-green-600 dark:text-green-400" : ""}
                    title="CPU usage of Claude process"
                  >
                    CPU {data.process_vitals.cpu_percent.toFixed(0)}%
                  </span>
                  <span className="opacity-40">·</span>
                  <span title="Resident memory">RAM {data.process_vitals.mem_mb} MB</span>
                  <span className="opacity-40">·</span>
                  <span title="Process uptime (how long the claude process has been running)">
                    {"up "}
                    {data.process_vitals.elapsed_secs < 60
                      ? `${data.process_vitals.elapsed_secs}s`
                      : data.process_vitals.elapsed_secs < 3600
                        ? `${Math.floor(data.process_vitals.elapsed_secs / 60)}m`
                        : `${Math.floor(data.process_vitals.elapsed_secs / 3600)}h`}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={data.process_vitals.has_established_tcp ? "text-blue-600 dark:text-blue-400" : "opacity-40"}
                    title={data.process_vitals.has_established_tcp
                      ? `${data.process_vitals.tcp_connections.length} ESTABLISHED TCP connections`
                      : "No active TCP connections"}
                  >
                    {data.process_vitals.has_established_tcp
                      ? `API: ${data.process_vitals.tcp_connections.length} conn`
                      : "API: idle"}
                  </span>
                  {data.file_age_ms != null && (
                    <>
                      <span className="opacity-40">·</span>
                      <span title="Time since Claude last wrote to the JSONL log (last tool call / message output)">
                        {"write "}
                        {data.file_age_ms < 60_000
                          ? `${Math.round(data.file_age_ms / 1000)}s ago`
                          : data.file_age_ms < 3_600_000
                            ? `${Math.floor(data.file_age_ms / 60_000)}m ago`
                            : `${Math.floor(data.file_age_ms / 3_600_000)}h ago`}
                      </span>
                    </>
                  )}
                </div>
              </div>
            )}
            <div className="text-[10px] text-muted-foreground/40 flex items-center gap-3">
              <span><kbd className="font-mono">Esc</kbd> stop</span>
              <span><kbd className="font-mono">⌘L</kbd> input</span>
            </div>

          </div>

          {/* Sent message confirmation */}
          {lastSentText && (
            <div className="shrink-0 px-4 pt-2">
              <div className="flex items-start gap-2 p-2 text-xs rounded-lg border border-green-500/20 bg-green-500/5 text-green-700 dark:text-green-400">
                <Check className="h-3 w-3 shrink-0 mt-0.5" />
                <span className="flex-1 line-clamp-2 break-words">{lastSentText}</span>
              </div>
            </div>
          )}

          {/* Input area — pinned to bottom */}
          <div className="shrink-0 px-4 pb-4 pt-2">
            {/* Hidden file input for new session */}
            <input
              ref={newFileInputRef}
              type="file"
              className="hidden"
              multiple
              onChange={handleNewSessionFileInput}
            />

            {/* Mode tabs — Reply | Issue only (no New — new session is a send action) */}
            <div className="inline-flex items-center gap-1 rounded-lg bg-muted p-1">
              <button
                onClick={() => {
                  setReplyMode("reply");
                  setTimeout(() => replyInputRef.current?.focus(), 50);
                }}
                className={`text-[11px] px-2.5 py-1 rounded-md transition-colors ${
                  replyMode === "reply"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground hover:bg-background/50"
                }`}
              >
                Reply
              </button>

              <button
                onClick={() => {
                  setReplyMode("issue");
                  setShowNewSessionOpts(false);
                  setTimeout(() => issueInputRef.current?.focus(), 50);
                }}
                className={`text-[11px] px-2.5 py-1 rounded-md transition-colors ${
                  replyMode === "issue"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground/50 hover:text-muted-foreground hover:bg-background/50"
                }`}
              >
                Issue
              </button>
            </div>

            {/* Reply textarea — single textarea for both reply and new session */}
            <div className={replyMode !== "reply" ? "hidden" : ""}>
              <ReplyInput
                ref={replyInputRef}
                sessionId={data.session_id}
                onSend={handleSend}
                queueSize={queuedMessages.length}
                isStreaming={isStreaming}
                bgClassName="border-border bg-muted/30"
              />
            </div>

            {/* Issue textarea */}
            {replyMode === "issue" && (
              <div className="border rounded-lg border-border bg-muted/20">
                <textarea
                  ref={issueInputRef}
                  value={issueDescription}
                  onChange={(e) => setIssueDescription(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      handleSubmitIssue();
                    }
                  }}
                  placeholder="Describe the issue..."
                  rows={16}
                  className="w-full resize-none bg-transparent rounded-lg px-3 py-2.5 text-[13px] placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
                  disabled={isSubmittingIssue}
                />
              </div>
            )}

            {/* Bottom bar: attach + new session + send */}
            <div className="flex items-center gap-1.5 mt-1.5 pl-0.5">
              {replyMode !== "issue" && (
                <button
                  onClick={() => replyInputRef.current?.triggerAttach()}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground/40 hover:text-muted-foreground transition-colors px-1.5 py-1 rounded hover:bg-muted/50"
                  title="Attach file"
                  type="button"
                >
                  <Paperclip className="h-3 w-3" />
                </button>
              )}

              <div className="flex-1" />

              {/* New Session — toggles options panel */}
              {replyMode === "reply" && settings?.new_session_from_reply === "true" && (
                <button
                  onClick={() => {
                    const next = !showNewSessionOpts;
                    setShowNewSessionOpts(next);
                    if (next && !newSessionPath) {
                      const msg = replyInputRef.current?.getText() || "";
                      if (msg.trim()) handleNewSessionAutodetect(msg);
                    }
                  }}
                  className={`text-[11px] px-2.5 py-1 rounded-md transition-colors border ${
                    showNewSessionOpts
                      ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-400"
                      : "border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/15 hover:border-emerald-500/60"
                  }`}
                  title={showNewSessionOpts ? "Hide new session options" : "New session options"}
                >
                  New ↗
                </button>
              )}

              {/* Send = reply to current session */}
              <button
                onClick={() => {
                  if (replyMode === "reply") replyInputRef.current?.triggerSend();
                  else if (replyMode === "issue") handleSubmitIssue();
                }}
                disabled={
                  replyMode === "issue" ? (!issueCategory || !issueDescription.trim() || isSubmittingIssue) :
                  false
                }
                className="text-[11px] px-2.5 py-1 rounded-md transition-colors disabled:opacity-30 bg-foreground text-background hover:bg-foreground/80"
              >
                {isSubmittingIssue && replyMode === "issue" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  "Send Reply"
                )}
              </button>
            </div>

            {/* Autodetect suggestions — shown after clicking New ↗ */}
            {replyMode === "reply" && showNewSessionOpts && newAutodetect.suggestions.length > 0 && (
              <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                {newAutodetect.suggestions.map((s, i) => {
                  const isSelected = newSessionPath === s.project_path;
                  return (
                    <button
                      key={s.project_dir}
                      onClick={() => {
                        setNewSessionPath(s.project_path);
                        newAutodetect.setAutodetected(true);
                        replyInputRef.current?.focus();
                      }}
                      className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border transition-colors ${
                        isSelected
                          ? "border-violet-500/50 bg-violet-500/10 text-violet-400"
                          : "border-border bg-card text-muted-foreground hover:border-violet-500/30 hover:text-violet-400"
                      }`}
                    >
                      <span className="text-[10px] text-muted-foreground/50">{i + 1}</span>
                      <FolderOpen className="h-3 w-3 shrink-0" />
                      <span className="truncate max-w-[120px]">{s.display_name}</span>
                    </button>
                  );
                })}
                <button
                  onClick={() => setFolderBrowserOpen(true)}
                  className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-dashed border-border text-muted-foreground/50 hover:border-violet-500/30 hover:text-violet-400 transition-colors"
                  title="Choose a different folder"
                >
                  <FolderPlus className="h-3 w-3 shrink-0" />
                  <span>other...</span>
                </button>
              </div>
            )}

            {/* New session options — visible after clicking New ↗ */}
            {replyMode === "reply" && showNewSessionOpts && settings?.new_session_from_reply === "true" && (
              <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                <button
                  onClick={() => setFolderBrowserOpen(true)}
                  className={`flex items-center gap-1 text-[11px] transition-colors px-1.5 py-0.5 rounded min-w-0 ${
                    newSessionPath
                      ? "text-violet-500 hover:text-violet-600 hover:bg-violet-500/10"
                      : "text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50"
                  }`}
                  title={newSessionPath || "Select folder for new session"}
                >
                  <FolderOpen className="h-3 w-3 shrink-0" />
                  <span className="truncate max-w-[140px]">
                    {newSessionPath ? newSessionPath.split(/[\\/]/).pop() : "folder..."}
                  </span>
                </button>
                <button
                  onClick={() => {
                    const msg = replyInputRef.current?.getText() || "";
                    handleNewSessionAutodetect(msg);
                  }}
                  disabled={newAutodetect.detecting}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground/50 hover:text-violet-500 disabled:opacity-30 transition-colors px-1.5 py-0.5 rounded hover:bg-violet-500/10"
                  title="Auto-detect project from your prompt"
                >
                  {newAutodetect.detecting ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Sparkles className="h-3 w-3" />
                  )}
                  <span>auto</span>
                </button>
                <button
                  onClick={skipPerms.toggle}
                  className={`flex items-center gap-1 text-[11px] transition-colors px-1.5 py-0.5 rounded ${
                    skipPerms.value
                      ? "text-amber-500 hover:text-amber-400 hover:bg-amber-500/10"
                      : "text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50"
                  }`}
                  title={skipPerms.value ? "Skip permissions enabled" : "Skip permissions disabled"}
                >
                  <ShieldOff className="h-3 w-3" />
                  <span>skip perms</span>
                  <span className={`font-medium ${skipPerms.value ? "text-amber-400" : "text-muted-foreground/60"}`}>
                    {skipPerms.value ? "on" : "off"}
                  </span>
                </button>
                <AgentToggleButton
                  agent={newSessionAgent}
                  onCycle={(next) => {
                    setNewSessionAgent(next);
                    setNewSessionModel(DEFAULT_MODEL[next]);
                  }}
                  size="md"
                />
                {compute.nodes.length > 0 && (
                  <button
                    onClick={compute.toggle}
                    className={`flex items-center gap-1 text-[11px] transition-colors px-1.5 py-0.5 rounded ${
                      compute.isLocal
                        ? "text-emerald-500 hover:text-emerald-400 hover:bg-emerald-500/10"
                        : "text-sky-500 hover:text-sky-400 hover:bg-sky-500/10"
                    }`}
                    title={compute.isLocal ? "Running locally — click to switch to VM" : `Running on ${compute.currentNode?.name} — click to switch`}
                  >
                    {compute.isLocal ? <Monitor className="h-3 w-3" /> : <Cloud className="h-3 w-3" />}
                    <span className="font-medium">
                      {compute.isLocal ? "local" : compute.currentNode?.name ?? "vm"}
                    </span>
                  </button>
                )}
                <label
                  className="flex items-center gap-1 text-[11px] text-muted-foreground/50 hover:text-muted-foreground cursor-pointer select-none px-1 py-0.5 rounded hover:bg-muted/50"
                  title={
                    !includeSummary
                      ? "Include relevant context from this session"
                      : settings?.gemini_configured === "true"
                        ? "Smart context: Gemini extracts only what's relevant"
                        : "Basic context: truncated transcript"
                  }
                >
                  <input
                    type="checkbox"
                    checked={includeSummary}
                    onChange={(e) => setIncludeSummary(e.target.checked)}
                    className="h-3 w-3 rounded border-muted-foreground/30"
                  />
                  <span>Context</span>
                  {includeSummary && settings?.gemini_configured !== "true" && (
                    <AlertTriangle className="h-3 w-3 text-amber-500" />
                  )}
                </label>
                <select
                  value={newSessionModel}
                  onChange={(e) => setNewSessionModel(e.target.value)}
                  className="text-[11px] px-1.5 py-0.5 rounded border border-border bg-card text-muted-foreground hover:border-violet-500/30 cursor-pointer max-w-[140px]"
                  title="Model for new session"
                >
                  {newSessionAgent === "forge"
                    ? MODEL_PRESETS.filter(p => p.model.startsWith("models/gemini") || p.model.startsWith("gemini") || p.model === "claude-sonnet-4-6").map(p => (
                        <option key={p.id} value={p.model}>{p.name}</option>
                      ))
                    : newSessionAgent === "codex"
                      ? MODEL_PRESETS.filter(p => p.model.startsWith("gpt")).map(p => (
                          <option key={p.id} value={p.model}>{p.name}</option>
                        ))
                      : MODEL_PRESETS.filter(p => p.model.startsWith("claude")).map(p => (
                          <option key={p.id} value={p.model}>{p.name}</option>
                        ))
                  }
                </select>

                <div className="flex-1" />

                {/* Start — explicit send action */}
                <button
                  onClick={async () => {
                    const msg = replyInputRef.current?.getText() || "";
                    if (!msg.trim()) return;
                    if (!newSessionPath) {
                      const firstPath = await newAutodetect.detect(msg);
                      if (firstPath) {
                        setNewSessionPath(firstPath);
                        setTimeout(() => handleStartNewSession(msg), 50);
                      } else {
                        setFolderBrowserOpen(true);
                      }
                      return;
                    }
                    handleStartNewSession(msg);
                    replyInputRef.current?.setText("");
                    setShowNewSessionOpts(false);
                  }}
                  disabled={startingNewSession}
                  className={`text-[11px] px-2.5 py-1 rounded-md transition-colors disabled:opacity-30 text-white ${
                    newSessionAgent === "codex"
                      ? "bg-violet-600 hover:bg-violet-500"
                      : "bg-emerald-600 hover:bg-emerald-500"
                  }`}
                >
                  {startingNewSession ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : newSessionAgent === "codex" ? (
                    "Terminal ↗"
                  ) : (
                    "Start ↗"
                  )}
                </button>
              </div>
            )}

            {/* Issue category picker — below button bar */}
            {replyMode === "issue" && (
              <div className="mt-1.5">
                <div className="flex flex-wrap gap-1.5">
                  {([
                    { key: "critical_problem", label: "Critical", icon: Flame, color: "red" },
                    { key: "repeated_bug", label: "Repeated bug", icon: Repeat, color: "orange" },
                    { key: "one_time_bug", label: "One-time bug", icon: Bug, color: "yellow" },
                    { key: "idea", label: "Idea", icon: Lightbulb, color: "blue" },
                    { key: "must_have_feature", label: "Must-have", icon: Rocket, color: "violet" },
                  ] as const).map(({ key, label, icon: Icon, color }) => {
                    const selected = issueCategory === key;
                    const colorMap: Record<string, string> = {
                      red: selected ? "border-red-500/50 bg-red-500/10 text-red-400" : "hover:border-red-500/30 hover:text-red-400",
                      orange: selected ? "border-orange-500/50 bg-orange-500/10 text-orange-400" : "hover:border-orange-500/30 hover:text-orange-400",
                      yellow: selected ? "border-yellow-500/50 bg-yellow-500/10 text-yellow-400" : "hover:border-yellow-500/30 hover:text-yellow-400",
                      blue: selected ? "border-blue-500/50 bg-blue-500/10 text-blue-400" : "hover:border-blue-500/30 hover:text-blue-400",
                      violet: selected ? "border-violet-500/50 bg-violet-500/10 text-violet-400" : "hover:border-violet-500/30 hover:text-violet-400",
                    };
                    return (
                      <button
                        key={key}
                        onClick={() => setIssueCategory(selected ? null : key)}
                        className={`flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md border transition-colors ${
                          selected
                            ? colorMap[color]
                            : `border-border bg-card text-muted-foreground ${colorMap[color]}`
                        }`}
                      >
                        <Icon className="h-3 w-3 shrink-0" />
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Folder browser dialog for new session */}
          <FolderBrowserDialog
            open={folderBrowserOpen}
            onOpenChange={setFolderBrowserOpen}
            onSelect={(path) => setNewSessionPath(path)}
          />
        </div>
      </div>

      {/* Skip Permissions warning dialog */}
      {skipPermsDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-background border border-border rounded-lg shadow-lg max-w-md w-full mx-4 p-6 space-y-4">
            <div className="space-y-2">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-yellow-500" />
                Skip Permissions is off
              </h3>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Web replies spawn <code className="text-[11px] px-1 py-0.5 bg-muted rounded">claude --resume -p</code> in
                headless mode. Without <strong>skip permissions</strong>, Claude will hang
                whenever it needs tool approval — there{"'"}s no terminal to approve it.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSkipPermsDialog(null)}
              >
                Cancel
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const msg = skipPermsDialog.message;
                  setSkipPermsDialog(null);
                  handleSendDirect(msg);
                }}
              >
                Send anyway
              </Button>
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    await fetch("/api/settings", {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ dangerously_skip_permissions: "true" }),
                    });
                    setSettings((prev) => prev ? { ...prev, dangerously_skip_permissions: "true" } : prev);
                  } catch { /* best effort */ }
                  const msg = skipPermsDialog.message;
                  setSkipPermsDialog(null);
                  handleSendDirect(msg);
                }}
              >
                Enable &amp; Send
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Context Guard warning dialog */}
      {contextGuardDialog?.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-background border border-border rounded-lg shadow-lg max-w-md w-full mx-4 p-6 space-y-4">
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">Off-topic message detected</h3>
              <p className="text-xs text-muted-foreground leading-relaxed">
                This question seems different from the session topic. Continuing may reduce
                response quality because Claude{"'"}s context window will mix unrelated topics.
              </p>
              <p className="text-[11px] text-muted-foreground/60">
                Off-topic confidence: {contextGuardDialog.score}%
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setContextGuardDialog(null);
                  router.push("/claude-sessions");
                }}
              >
                Start new session
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  if (contextGuardDialog) {
                    handleSendDirect(contextGuardDialog.message);
                  }
                  setContextGuardDialog(null);
                }}
              >
                Send anyway
              </Button>
            </div>
          </div>
        </div>
      )}
      <Toaster
        theme="dark"
        position="bottom-right"
        toastOptions={{
          style: {
            background: "hsl(var(--popover))",
            color: "hsl(var(--popover-foreground))",
            border: "1px solid hsl(var(--border))",
          },
        }}
      />
    </>
  );
}
