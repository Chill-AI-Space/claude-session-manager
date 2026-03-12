"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { SessionList } from "@/components/SessionList";
import { SessionSearch, GeminiResult } from "@/components/SessionSearch";
import { SessionListItem, ProjectListItem } from "@/lib/types";
import { GDriveAccount } from "@/lib/gdrive";
import {
  RefreshCw, Loader2, PanelLeft, PanelLeftClose, Sparkles,
  Settings, Package, BarChart2, Archive, CircleHelp, ClipboardList,
  Sun, Moon,
} from "lucide-react";
import { FileBrowser } from "@/components/FileBrowser";
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
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
const [sidebarOpen, setSidebarOpen] = useState(true);
  const [geminiResults, setGeminiResults] = useState<GeminiResult[]>([]);
  const [contentSearching, setContentSearching] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [activeTab, setActiveTab] = useState<"sessions" | "files">("sessions");
  const [gdAccounts, setGdAccounts] = useState<GDriveAccount[]>([]);
  const [generatingTitles, setGeneratingTitles] = useState(false);
  const [titlesGenerated, setTitlesGenerated] = useState<number | null>(null);
  const initialLoadDone = useRef(false);
  const sessionsRef = useRef(sessions);

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

  const fetchSessions = useCallback(async () => {
    const params = new URLSearchParams();
    if (selectedProject) params.set("project", selectedProject);
    if (searchQuery) params.set("search", searchQuery);
    params.set("sort", "modified");
    params.set("limit", "200");

    const res = await fetch(`/api/sessions?${params}`);
    const data = await res.json();
    setSessions(data.sessions);
    setLoading(false);
  }, [selectedProject, searchQuery]);

  const fetchProjects = useCallback(async () => {
    const res = await fetch("/api/projects");
    const data = await res.json();
    setProjects(data.projects);
  }, []);

  const fetchGDriveAccounts = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      const data = await res.json();
      if (data.gdrive_accounts) {
        setGdAccounts(JSON.parse(data.gdrive_accounts));
      }
    } catch { /* ignore */ }
  }, []);

  async function triggerScan(mode: "full" | "incremental" = "incremental"): Promise<void> {
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
  }


  const archiveSession = useCallback(async (sessionId: string) => {
    setSessions((prev) => prev.filter((s) => s.session_id !== sessionId));
    await fetch(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
  }, []);

  useEffect(() => {
    Promise.all([fetchSessions(), fetchProjects(), fetchGDriveAccounts()]).then(() => {
      initialLoadDone.current = true;
      triggerScan("incremental");
    });
  }, []);

  sessionsRef.current = sessions;

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

  // Auto content search: when basic search returns 0 results, grep JSONL files
  useEffect(() => {
    if (!searchQuery || searchQuery.length < 3 || sessions.length > 0 || loading || geminiResults.length > 0) {
      setContentSearching(false);
      return;
    }
    setContentSearching(true);
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
          // Fetch the matched sessions by ID (they may not be in the current sessions list)
          const idsParam = data.session_ids.join(",");
          const matchedRes = await fetch(
            `/api/sessions?ids=${idsParam}&limit=${data.session_ids.length}`,
            { signal: abortController.signal }
          );
          const matchedData = await matchedRes.json();
          if (abortController.signal.aborted) return;
          // Merge matched sessions into current list
          setSessions((prev) => {
            const existingIds = new Set(prev.map((s) => s.session_id));
            const newOnes = (matchedData.sessions || []).filter(
              (s: SessionListItem) => !existingIds.has(s.session_id)
            );
            return newOnes.length > 0 ? [...prev, ...newOnes] : prev;
          });
          setGeminiResults(
            data.session_ids.map((id: string) => ({
              session_id: id,
              snippet: "Found in message content",
              relevance: "content",
              query: searchQuery,
            }))
          );
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
  }, [searchQuery, sessions.length, loading, geminiResults.length]);

  useEffect(() => {
    if (initialLoadDone.current) fetchSessions();
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
            {/* Tab switcher */}
            <div className="flex gap-1 mb-2 bg-muted/40 rounded-md p-0.5">
              <button
                onClick={() => setActiveTab("sessions")}
                className={cn(
                  "flex-1 text-xs py-1 rounded transition-colors",
                  activeTab === "sessions"
                    ? "bg-background text-foreground shadow-sm font-medium"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                Sessions
              </button>
              <button
                onClick={() => setActiveTab("files")}
                className={cn(
                  "flex-1 text-xs py-1 rounded transition-colors",
                  activeTab === "files"
                    ? "bg-background text-foreground shadow-sm font-medium"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                Files
              </button>
            </div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-foreground tracking-tight">
                {activeTab === "sessions" ? "Sessions" : "Files"}
              </span>
              <div className="flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={generateTitles}
                  disabled={generatingTitles}
                  title={titlesGenerated !== null ? `Generated ${titlesGenerated} titles` : "Generate AI titles"}
                >
                  {generatingTitles ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className={cn("h-3.5 w-3.5", titlesGenerated !== null && titlesGenerated > 0 && "text-yellow-500")} />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => triggerScan("incremental")}
                  disabled={scanning}
                  title="Refresh sessions"
                >
                  {scanning ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                </Button>
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
            </div>
            {activeTab === "sessions" && (
              <SessionSearch
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                onGeminiResults={handleGeminiResults}
              />
            )}
          </div>

          {activeTab === "sessions" ? (
            <SessionList sessions={sessions} loading={loading || contentSearching} geminiResults={geminiResults} onArchive={archiveSession} />
          ) : (
            <FileBrowser projects={projects} gdAccounts={gdAccounts} />
          )}
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

        {/* Right nav strip — visible on utility pages (not session detail) */}
        {!/^\/claude-sessions\/[a-f0-9-]{8,}/.test(pathname) && (
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
        )}
      </div>
    </div>
  );
}
