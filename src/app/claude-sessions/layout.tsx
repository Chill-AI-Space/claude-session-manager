"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { SessionList } from "@/components/SessionList";
import { SessionSearch, GeminiResult } from "@/components/SessionSearch";
import { SessionListItem, ProjectListItem } from "@/lib/types";
import {
  RefreshCw, Loader2, PanelLeft, PanelLeftClose, Sparkles,
  Settings, Package, BarChart2, Archive, CircleHelp, ClipboardList,
  Sun, Moon, Plus, Download, Check, AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Suppress abort-related unhandled rejections in Next.js dev overlay
if (typeof window !== "undefined") {
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    if (
      r === "cancelled" ||
      (r instanceof DOMException && r.name === "AbortError")
    ) {
      e.preventDefault();
    }
  });
}

export default function SessionsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
const [sidebarOpen, setSidebarOpen] = useState(true);
  const [geminiResults, setGeminiResults] = useState<GeminiResult[]>([]);
  const [contentSearching, setContentSearching] = useState(false);
  const [sessionsSearching, setSessionsSearching] = useState(false);
  const [searchPending, setSearchPending] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [generatingTitles, setGeneratingTitles] = useState(false);
  const [titlesGenerated, setTitlesGenerated] = useState<number | null>(null);
  const initialLoadDone = useRef(false);
  const sessionsRef = useRef(sessions);
  const [updateStatus, setUpdateStatus] = useState<"idle" | "checking" | "updating" | "done" | "error" | "restarting">("idle");
  const [updateStep, setUpdateStep] = useState("");
  const [updatesAvailable, setUpdatesAvailable] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const MAX_SESSIONS_IN_MEMORY = 5000;

  // Check for updates on mount (silent background check)
  useEffect(() => {
    fetch("/api/update")
      .then((r) => r.json())
      .then((data) => {
        if (data.updates_available) setUpdatesAvailable(true);
      })
      .catch(() => {});
  }, []);

  function pollUntilServerReturns() {
    setUpdateStatus("restarting");
    setUpdateStep("Restarting server...");
    setUpdatesAvailable(false);
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      try {
        const r = await fetch("/api/health", { signal: AbortSignal.timeout(2000) });
        if (r.ok) {
          clearInterval(poll);
          setUpdateStatus("done");
          setUpdateStep("Updated!");
          setTimeout(() => window.location.reload(), 1500);
        }
      } catch {
        if (attempts > 60) {
          clearInterval(poll);
          setUpdateStatus("error");
          setUpdateStep("Server didn't come back");
        }
      }
    }, 2000);
  }

  async function triggerUpdate() {
    if (updateStatus === "updating" || updateStatus === "restarting") return;
    setUpdateStatus("updating");
    setUpdateStep("Starting...");
    let lastStep = 0;
    let gotDone = false;
    try {
      const res = await fetch("/api/update", { method: "POST" });
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No stream");
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n\n");
        buf = lines.pop() || "";
        for (const block of lines) {
          const eventMatch = block.match(/^event: (\w+)/);
          const dataMatch = block.match(/^data: (.+)$/m);
          if (!eventMatch || !dataMatch) continue;
          const event = eventMatch[1];
          const data = JSON.parse(dataMatch[1]);
          if (event === "step") {
            setUpdateStep(data.label);
            if (data.step) lastStep = data.step;
          } else if (event === "step_done") {
            if (data.step) lastStep = data.step;
          } else if (event === "error") {
            setUpdateStatus("error");
            setUpdateStep(data.message);
            return;
          } else if (event === "done") {
            gotDone = true;
            if (data.restarting) {
              pollUntilServerReturns();
            } else {
              // "Already up to date"
              setUpdateStatus("done");
              setUpdateStep(data.message);
              setUpdatesAvailable(false);
              setTimeout(() => { setUpdateStatus("idle"); setUpdateStep(""); }, 3000);
            }
          }
        }
      }
      // Stream ended cleanly but we never got "done" — build likely completed, server restarting
      if (!gotDone && lastStep >= 3) {
        pollUntilServerReturns();
      }
    } catch {
      // Stream broke — if we got past the build step, assume server is restarting
      if (lastStep >= 3) {
        pollUntilServerReturns();
      } else if (lastStep >= 1) {
        // Pull happened but build/restart unclear — try polling anyway
        pollUntilServerReturns();
      } else {
        setUpdateStatus("error");
        setUpdateStep("Connection lost");
        setTimeout(() => { setUpdateStatus("idle"); setUpdateStep(""); }, 5000);
      }
    }
  }

  useEffect(() => {
    const saved = localStorage.getItem("theme") as "light" | "dark" | null;
    const resolved = saved === "light" ? "light" : "dark";
    setTheme(resolved);
    document.documentElement.className = resolved === "light" ? "" : "dark";

    const savedScale = localStorage.getItem("fontSizeScale");
    if (savedScale) {
      document.documentElement.style.fontSize = `${(parseInt(savedScale) / 100) * 16}px`;
    }
  }, []);

  function toggleTheme(): void {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("theme", next);
    document.documentElement.className = next === "light" ? "" : "dark";
  }

  async function generateTitles(): Promise<void> {
    setGeneratingTitles(true);
    setTitlesGenerated(null);
    try {
      const res = await fetch("/api/sessions/generate-titles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 50 }),
      });
      const data = await res.json();
      setTitlesGenerated(data.generated || 0);
      if (data.generated > 0) await fetchSessions();
      setTimeout(() => setTitlesGenerated(null), 3000);
    } catch { /* ignore */ }
    setGeneratingTitles(false);
  }

  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const SIDEBAR_PAGE_SIZE = 40;

  const fetchSessions = useCallback(async () => {
    // Cancel any pending lazy-load request
    abortControllerRef.current?.abort("cancelled");
    const abort = new AbortController();
    abortControllerRef.current = abort;
    const isSearchRequest = !!searchQuery || selectedProjects.length > 0;
    if (isSearchRequest) setSessionsSearching(true);

    const params = new URLSearchParams();
    if (selectedProjects.length > 0) params.set("project", selectedProjects.join(","));
    if (searchQuery) params.set("search", searchQuery);
    params.set("sort", "modified");
    // On auto-refresh, preserve the user's loaded count so scroll position isn't reset
    const fetchLimit = Math.max(SIDEBAR_PAGE_SIZE, sessionsRef.current.length);
    params.set("limit", String(fetchLimit));
    // Skip remote nodes for instant sidebar load; fetch them lazily below
    params.set("include_remote", "false");

    try {
      const res = await fetch(`/api/sessions?${params}`);
      const data = await res.json();

      // Apply memory limit: keep only first MAX_SESSIONS_IN_MEMORY
      const limitedSessions = (data.sessions || []).slice(0, MAX_SESSIONS_IN_MEMORY);
      setSessions(limitedSessions);
      setHasMore(limitedSessions.length < (data.total ?? 0));
      setLoading(false);

      // Lazy-load remote sessions in background (non-blocking)
      fetch(`/api/sessions?sort=modified&limit=${MAX_SESSIONS_IN_MEMORY}&include_remote=true`, {
        signal: abort.signal,
      })
        .then(r => r.json())
        .then(remoteData => {
          if (abort.signal.aborted) return;
          const remoteSessions = (remoteData.sessions || []).filter(
            (s: Record<string, unknown>) => s._remote
          );
          if (remoteSessions.length > 0) {
            setSessions(prev => {
              if (abort.signal.aborted) return prev;
              const localIds = new Set(prev.map((s) => s.session_id));
              const newRemote = remoteSessions.filter(
                (s: SessionListItem) => !localIds.has(s.session_id)
              );
              if (newRemote.length === 0) return prev;
              // Merge and sort by modified_at descending, then apply limit
              const merged = [...prev, ...newRemote];
              merged.sort((a, b) => {
                const aTime = String(a.modified_at || "");
                const bTime = String(b.modified_at || "");
                return bTime.localeCompare(aTime);
              });
              return merged.slice(0, MAX_SESSIONS_IN_MEMORY);
            });
          }
        })
        .catch(() => {}); // remote unavailable or aborted — no problem
    } catch {
      // Main fetch failed — ignore, will retry on next poll
      setLoading(false);
    } finally {
      if (isSearchRequest) setSessionsSearching(false);
    }
  }, [selectedProjects, searchQuery]);

  const loadMoreSessions = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    // Don't load more if we're already at the memory limit
    if (sessions.length >= MAX_SESSIONS_IN_MEMORY) return;

    setLoadingMore(true);
    const params = new URLSearchParams();
    if (selectedProjects.length > 0) params.set("project", selectedProjects.join(","));
    if (searchQuery) params.set("search", searchQuery);
    params.set("sort", "modified");
    // Only fetch up to the memory limit
    const remaining = MAX_SESSIONS_IN_MEMORY - sessions.length;
    params.set("limit", String(Math.min(SIDEBAR_PAGE_SIZE, remaining)));
    params.set("offset", String(sessions.length));
    params.set("include_remote", "false");

    try {
      const res = await fetch(`/api/sessions?${params}`);
      const data = await res.json();
      const newSessions = data.sessions || [];
      setSessions(prev => {
        const merged = [...prev, ...newSessions];
        return merged.slice(0, MAX_SESSIONS_IN_MEMORY);
      });
      setHasMore(sessions.length + newSessions.length < (data.total ?? 0));
    } catch { /* ignore */ }
    setLoadingMore(false);
  }, [loadingMore, hasMore, selectedProjects, searchQuery, sessions.length]);

  const fetchProjects = useCallback(async () => {
    const res = await fetch("/api/projects");
    const data = await res.json();
    setProjects(data.projects);
  }, []);


  const triggerScan = useCallback(async (mode: "full" | "incremental" = "incremental"): Promise<void> => {
    setScanning(true);
    await fetch("/api/sessions/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    await Promise.all([fetchSessions(), fetchProjects()]);
    setScanning(false);
    // Signal the open session detail page to re-fetch
    window.dispatchEvent(new Event("sessions-scanned"));
  }, [fetchSessions, fetchProjects]);

  const archiveSession = useCallback(async (sessionId: string) => {
    setSessions((prev) => prev.filter((s) => s.session_id !== sessionId));
    await fetch(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
  }, []);

  useEffect(() => {
    Promise.all([fetchSessions(), fetchProjects()]).then(() => {
      initialLoadDone.current = true;
      triggerScan("incremental").then(() => {
        // Background: auto-generate titles for sessions that don't have them
        // Runs lazily after scan, doesn't block UI. Generates summaries first, then titles.
        fetch("/api/sessions/generate-titles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limit: 10 }),
        })
          .then(r => r.json())
          .then(data => {
            if (data.generated > 0) fetchSessions(); // refresh sidebar with new titles
          })
          .catch(() => {});
      });
    });
  }, []);

  // Listen for session-started events from useSessionStart — trigger immediate refresh + track appearance
  useEffect(() => {
    function handleSessionStarted(e: Event) {
      const { sessionId, correlationId } = (e as CustomEvent).detail ?? {};
      if (!sessionId || !correlationId) return;

      // Trigger scan + refresh so session appears in sidebar ASAP
      triggerScan("incremental").then(() => {
        const found = sessionsRef.current.some((s) => s.session_id === sessionId);
        fetch("/api/sessions/track", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: found ? "session_start_in_sidebar" : "session_start_missing_from_sidebar",
            correlationId,
            sessionId,
            meta: { sessionsCount: sessionsRef.current.length },
          }),
        }).catch(() => {});
      });
    }
    window.addEventListener("session-started", handleSessionStarted);
    return () => window.removeEventListener("session-started", handleSessionStarted);
  }, [triggerScan]);

  sessionsRef.current = sessions;

  // Cleanup: abort any pending fetch on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort("unmount");
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      const hasRecentActivity = sessionsRef.current.some((s) => {
        if (s.is_active) return true;
        const ageMs = now - new Date(s.modified_at).getTime();
        return ageMs < 3 * 60_000;
      });
      // Don't auto-refresh while a content search is showing (would overwrite results)
      if (hasRecentActivity && !geminiResults.length) fetchSessions();
    }, 10_000);
    return () => clearInterval(id);
  }, [fetchSessions, geminiResults.length]); // sessions excluded via ref to avoid restarting interval on every poll

  // Clear content results when search query changes
  useEffect(() => {
    if (!searchQuery) setGeminiResults([]);
  }, [searchQuery]);

  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchPending(false);
      return;
    }
    setSearchPending(true);
    const timer = setTimeout(() => setSearchPending(false), 250);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Wrapper for Gemini results: set results AND fetch any missing sessions by ID
  const handleGeminiResults = useCallback(async (results: GeminiResult[]) => {
    setGeminiResults(results);
    if (results.length === 0) return;
    const ids = results.map((r) => r.session_id);
    try {
      const res = await fetch(`/api/sessions?ids=${ids.join(",")}&limit=${ids.length}`);
      const data = await res.json();
      const fetched: SessionListItem[] = data.sessions || [];
      if (fetched.length > 0) {
        setSessions((prev) => {
          const existingIds = new Set(prev.map((s) => s.session_id));
          const newOnes = fetched.filter((s) => !existingIds.has(s.session_id));
          return newOnes.length > 0 ? [...prev, ...newOnes] : prev;
        });
      }
    } catch { /* ignore */ }
  }, []);

  // Wave 2 content search: runs in parallel with title search via FTS5.
  // Fires for every query >= 3 chars, merges extra results not found by title search.
  useEffect(() => {
    if (!searchQuery || searchQuery.length < 3 || loading || geminiResults.length > 0) {
      setContentSearching(false);
      return;
    }
    // Show spinner only when title search also returned nothing yet
    if (sessionsRef.current.length === 0) setContentSearching(true);

    const abortController = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/sessions/search-content?q=${encodeURIComponent(searchQuery)}`,
          { signal: abortController.signal }
        );
        const data = await res.json();
        if (abortController.signal.aborted) return;
        if (data.session_ids?.length > 0) {
          const idsParam = data.session_ids.join(",");
          const matchedRes = await fetch(
            `/api/sessions?ids=${idsParam}&limit=${data.session_ids.length}`,
            { signal: abortController.signal }
          );
          const matchedData = await matchedRes.json();
          if (abortController.signal.aborted) return;

          // Snapshot title-search results before merging
          const titleIds = new Set(sessionsRef.current.map((s) => s.session_id));
          const allMatched: SessionListItem[] = matchedData.sessions || [];

          // Add sessions not already shown by title search
          const newOnes = allMatched.filter((s) => !titleIds.has(s.session_id));
          if (newOnes.length > 0) {
            setSessions((prev) => {
              const existingIds = new Set(prev.map((s) => s.session_id));
              const toAdd = newOnes.filter((s) => !existingIds.has(s.session_id));
              return toAdd.length > 0 ? [...prev, ...toAdd] : prev;
            });
          }

          // Only switch SessionList into "search-result mode" when title search found nothing.
          // Otherwise keep the normal list and just append extra content matches.
          const badgeIds = titleIds.size === 0 ? data.session_ids : [];
          if (badgeIds.length > 0) {
            setGeminiResults(
              badgeIds.map((id: string) => ({
                session_id: id,
                snippet: "Found in message content",
                relevance: "content",
                query: searchQuery,
              }))
            );
          }
        }
      } catch {
        /* ignore — includes AbortError */
      } finally {
        if (!abortController.signal.aborted) setContentSearching(false);
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      abortController.abort("cancelled");
      setContentSearching(false);
    };
  }, [searchQuery, loading, geminiResults.length]); // no sessions.length — avoids loop when wave 2 adds results

  useEffect(() => {
    if (initialLoadDone.current) fetchSessions();
    // Abort any pending requests when search/projects change
    return () => {
      abortControllerRef.current?.abort("query-changed");
    };
  }, [fetchSessions]);

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Sidebar */}
      <div
        className={cn(
          "flex flex-col bg-sidebar border-r border-sidebar-border transition-[width] duration-200 ease-in-out overflow-hidden shrink-0",
          "dark:border-r-0",
          sidebarOpen ? "w-80" : "w-0"
        )}
      >
        <div className="flex flex-col h-full min-h-0 min-w-[320px]">
          {/* Sidebar header */}
          <div className="p-3 border-b border-sidebar-border">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-semibold text-foreground tracking-tight">
                  Sessions
                </span>
                <Link href="/claude-sessions">
                  <Button
                    size="sm"
                    className="h-5 px-1.5 text-[11px] border border-emerald-600 text-emerald-600 hover:bg-emerald-600/10 bg-transparent rounded"
                  >
                    <Plus className="h-3 w-3 mr-0.5" />
                    New
                  </Button>
                </Link>
                {(updatesAvailable || updateStatus !== "idle") && (
                  <Button
                    size="sm"
                    onClick={triggerUpdate}
                    disabled={updateStatus === "updating" || updateStatus === "restarting"}
                    title={
                      updateStatus === "updating" ? updateStep :
                      updateStatus === "restarting" ? "Restarting server..." :
                      updateStatus === "done" ? updateStep :
                      updateStatus === "error" ? updateStep :
                      "Update available — click to install"
                    }
                    className={cn(
                      "h-5 px-1.5 text-[11px] border bg-transparent rounded",
                      updateStatus === "error"
                        ? "border-red-500 text-red-500 hover:bg-red-500/10"
                        : updateStatus === "done"
                        ? "border-emerald-600 text-emerald-600 hover:bg-emerald-600/10"
                        : "border-blue-500 text-blue-500 hover:bg-blue-500/10 animate-pulse"
                    )}
                  >
                    {updateStatus === "updating" || updateStatus === "restarting" ? (
                      <Loader2 className="h-3 w-3 mr-0.5 animate-spin" />
                    ) : updateStatus === "done" ? (
                      <Check className="h-3 w-3 mr-0.5" />
                    ) : updateStatus === "error" ? (
                      <AlertCircle className="h-3 w-3 mr-0.5" />
                    ) : (
                      <Download className="h-3 w-3 mr-0.5" />
                    )}
                    {updateStatus === "updating" ? "Updating" :
                     updateStatus === "restarting" ? "Restarting" :
                     updateStatus === "done" ? "Done" :
                     updateStatus === "error" ? "Error" :
                     "Update"}
                  </Button>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setSidebarOpen(false)}
                title="Hide sidebar"
              >
                <PanelLeftClose className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="flex items-center gap-1">
              <div className="flex-1 min-w-0">
                <SessionSearch
                  searchQuery={searchQuery}
                  onSearchChange={setSearchQuery}
                  onGeminiResults={handleGeminiResults}
                  projects={projects}
                  selectedProjects={selectedProjects}
                  onProjectFilterChange={setSelectedProjects}
                  searchPending={searchPending}
                  sessionsSearching={sessionsSearching}
                  contentSearching={contentSearching}
                />
              </div>
              <button
                onClick={() => triggerScan("incremental")}
                disabled={scanning}
                title="Refresh sessions"
                className="flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-40 shrink-0"
              >
                {scanning ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>

          <SessionList sessions={sessions} loading={loading} geminiResults={geminiResults} onArchive={archiveSession} hasMore={hasMore} loadingMore={loadingMore} onLoadMore={loadMoreSessions} />
        </div>
      </div>

      {/* Main content + right nav */}
      <div className="flex-1 flex min-w-0 min-h-0">
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* Toggle button when sidebar is closed */}
          {!sidebarOpen && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-2.5 left-2.5 z-20 h-8 w-8"
              onClick={() => setSidebarOpen(true)}
              title="Show sidebar"
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
          )}
          {children}
        </div>

        {/* Right nav strip — always visible */}
        <div className="w-11 shrink-0 border-l border-sidebar-border flex flex-col items-center py-3 gap-0.5 bg-sidebar">
            {([
              { href: "/claude-sessions/settings", icon: Settings, label: "Settings" },
              { href: "/claude-sessions/store", icon: Package, label: "Store" },
              { href: "/claude-sessions/analytics", icon: BarChart2, label: "Analytics" },
              { href: "/claude-sessions/actions", icon: ClipboardList, label: "Actions" },
              { href: "/claude-sessions/archive", icon: Archive, label: "Archive" },
              { href: "/claude-sessions/help", icon: CircleHelp, label: "Help" },
            ] as const).map(({ href, icon: Icon, label }) => (
              <Link
                key={href}
                href={href}
                title={label}
                className={cn(
                  "flex items-center justify-center w-8 h-8 rounded-md transition-colors",
                  pathname === href
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground/60 hover:text-foreground hover:bg-muted/50"
                )}
              >
                <Icon className="h-4 w-4" />
              </Link>
            ))}
            <div className="flex-1" />
            <button
              onClick={generateTitles}
              disabled={generatingTitles}
              title={titlesGenerated !== null ? `Generated ${titlesGenerated} titles` : "Generate AI titles"}
              className="flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-40"
            >
              {generatingTitles ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className={cn("h-4 w-4", titlesGenerated !== null && titlesGenerated > 0 && "text-yellow-500")} />
              )}
            </button>
            <button
              onClick={() => triggerScan("incremental")}
              disabled={scanning}
              title="Refresh sessions"
              className="flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-40"
            >
              {scanning ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
            </button>
            <button
              onClick={() => {
                const next = theme === "dark" ? "light" : "dark";
                setTheme(next);
                document.documentElement.className = next === "light" ? "" : "dark";
                localStorage.setItem("theme", next);
              }}
              title="Toggle theme"
              className="flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-muted/50 transition-colors"
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
      </div>
    </div>
  );
}
