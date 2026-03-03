"use client";

import { useState, useEffect, useCallback } from "react";
import { SessionList } from "@/components/SessionList";
import { SessionSearch } from "@/components/SessionSearch";
import { SessionListItem, ProjectListItem } from "@/lib/types";
import { RefreshCw, Loader2, PanelLeft, PanelLeftClose, Settings } from "lucide-react";
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

  useEffect(() => {
    triggerScan("incremental");
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Sidebar */}
      <div
        className={cn(
          "flex flex-col border-r border-border bg-card transition-[width] duration-200 ease-in-out overflow-hidden shrink-0",
          sidebarOpen ? "w-80" : "w-0 border-r-0"
        )}
      >
        <div className="flex flex-col h-full min-h-0 min-w-[320px]">
          {/* Sidebar header */}
          <div className="p-3 border-b border-border">
            <div className="flex items-center justify-between mb-2">
              <h1 className="text-sm font-semibold text-foreground tracking-tight">
                Sessions
              </h1>
              <div className="flex items-center gap-0.5">
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
            />
          </div>

          <SessionList sessions={sessions} loading={loading} />

          {/* Settings link */}
          <div className="border-t border-border p-2">
            <Link
              href="/sessions/settings"
              className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground rounded transition-colors"
            >
              <Settings className="h-3.5 w-3.5" />
              Settings
            </Link>
          </div>
        </div>
      </div>

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
