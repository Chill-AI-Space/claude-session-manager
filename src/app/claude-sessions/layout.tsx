"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { SessionList } from "@/components/SessionList";
import { SessionSearch, GeminiResult } from "@/components/SessionSearch";
import { SessionListItem, ProjectListItem } from "@/lib/types";
import { RefreshCw, Loader2, PanelLeft, PanelLeftClose, Settings, Sparkles, ChevronRight, Sun, Moon } from "lucide-react";
import { FolderBrowserDialog } from "@/components/FolderBrowserDialog";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function SessionsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<"modified" | "created" | "tokens">(
    "modified"
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [generatingTitles, setGeneratingTitles] = useState(false);
  const [titleStats, setTitleStats] = useState<string | null>(null);
  const [geminiResults, setGeminiResults] = useState<GeminiResult[]>([]);
  const [startSessionOpen, setStartSessionOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("dark");

  useEffect(() => {
    const saved = localStorage.getItem("theme") as "light" | "dark" | null;
    const resolved = saved === "light" ? "light" : "dark";
    setTheme(resolved);
    document.documentElement.className = resolved === "light" ? "" : "dark";
  }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("theme", next);
    document.documentElement.className = next === "light" ? "" : "dark";
  };

  const fetchSessions = useCallback(async () => {
    const params = new URLSearchParams();
    if (selectedProject) params.set("project", selectedProject);
    if (searchQuery) params.set("search", searchQuery);
    params.set("sort", sortBy);
    params.set("limit", "200");

    const res = await fetch(`/api/sessions?${params}`);
    const data = await res.json();
    setSessions(data.sessions);
    setLoading(false);
    // Clear Gemini results when basic filters change
    setGeminiResults([]);
  }, [selectedProject, searchQuery, sortBy]);

  const fetchProjects = useCallback(async () => {
    const res = await fetch("/api/projects");
    const data = await res.json();
    setProjects(data.projects);
  }, []);

  const triggerScan = async (mode: "full" | "incremental" = "incremental") => {
    setScanning(true);
    await fetch("/api/sessions/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    await Promise.all([fetchSessions(), fetchProjects()]);
    setScanning(false);
  };

  const generateTitles = async () => {
    setGeneratingTitles(true);
    setTitleStats(null);
    try {
      let totalGenerated = 0;
      // Generate in batches until done
      for (let i = 0; i < 20; i++) {
        const res = await fetch("/api/sessions/generate-titles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limit: 20 }),
        });
        const data = await res.json();
        if (data.generated === 0 || data.error) break;
        totalGenerated += data.generated;
        setTitleStats(`${totalGenerated} titles generated...`);
        // Refresh list to show new titles
        await fetchSessions();
      }
      setTitleStats(totalGenerated > 0 ? `${totalGenerated} titles generated` : "All sessions have titles");
      setTimeout(() => setTitleStats(null), 3000);
    } catch {
      setTitleStats("Error generating titles");
      setTimeout(() => setTitleStats(null), 3000);
    } finally {
      setGeneratingTitles(false);
    }
  };

  const initialLoadDone = useRef(false);

  useEffect(() => {
    // Show cached sessions immediately, then scan in background
    Promise.all([fetchSessions(), fetchProjects()]).then(() => {
      initialLoadDone.current = true;
      triggerScan("incremental");
    });
  }, []);

  // Re-fetch when filters change (but not on initial mount — triggerScan handles that)
  useEffect(() => {
    if (initialLoadDone.current) {
      fetchSessions();
    }
  }, [fetchSessions]);

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Sidebar */}
      <div
        className={cn(
          "flex flex-col bg-card transition-[width] duration-200 ease-in-out overflow-hidden shrink-0",
          sidebarOpen ? "w-80" : "w-0"
        )}
      >
        <div className="flex flex-col h-full min-h-0 min-w-[320px]">
          {/* Sidebar header */}
          <div className="p-3 border-b border-border">
            <div className="flex items-center justify-between mb-2">
              <button
                onClick={() => setStartSessionOpen(true)}
                className="flex items-center gap-1 text-sm font-semibold text-foreground tracking-tight hover:text-muted-foreground transition-colors"
              >
                Start session
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
              <div className="flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={toggleTheme}
                  title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
                >
                  {theme === "dark" ? (
                    <Sun className="h-3.5 w-3.5" />
                  ) : (
                    <Moon className="h-3.5 w-3.5" />
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
            <SessionSearch
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              projects={projects}
              selectedProject={selectedProject}
              onProjectChange={setSelectedProject}
              sortBy={sortBy}
              onSortChange={setSortBy}
              onGeminiResults={setGeminiResults}
            />
          </div>

          <SessionList sessions={sessions} loading={loading} geminiResults={geminiResults} />

          {/* Footer */}
          <div className="border-t border-border p-2 space-y-1">
            {titleStats && (
              <div className="px-3 py-1 text-[10px] text-muted-foreground/70 flex items-center gap-1.5">
                {generatingTitles && <Loader2 className="h-3 w-3 animate-spin" />}
                {titleStats}
              </div>
            )}
            <button
              onClick={generateTitles}
              disabled={generatingTitles}
              className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground rounded transition-colors w-full text-left disabled:opacity-50"
            >
              {generatingTitles ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              Generate titles
            </button>
            <Link
              href="/claude-sessions/settings"
              className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground rounded transition-colors"
            >
              <Settings className="h-3.5 w-3.5" />
              Settings
            </Link>
          </div>
        </div>
      </div>

      <FolderBrowserDialog open={startSessionOpen} onOpenChange={setStartSessionOpen} />

      {/* Main content */}
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
    </div>
  );
}
