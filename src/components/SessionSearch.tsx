"use client";

import { Input } from "@/components/ui/input";
import { Search, X, DollarSign, Filter, HelpCircle, Loader2, Settings, ChevronDown, Check, FolderOpen } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { ProjectListItem } from "@/lib/types";

interface SessionSearchProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onGeminiResults?: (results: GeminiResult[]) => void;
  projects?: ProjectListItem[];
  selectedProjects?: string[];
  onProjectFilterChange?: (projectDirs: string[]) => void;
}

export interface GeminiResult {
  session_id: string;
  snippet: string;
  relevance: string;
  query?: string; // original search term, used for in-session highlighting
}

interface SettingResult {
  key: string;
  description: string;
  defaultValue: string;
  section: string;
  pluginId?: string;
}

export function SessionSearch({
  searchQuery,
  onSearchChange,
  onGeminiResults,
  projects,
  selectedProjects,
  onProjectFilterChange,
}: SessionSearchProps) {
  const router = useRouter();
  const [geminiQuery, setGeminiQuery] = useState("");
  const [geminiLoading, setGeminiLoading] = useState(false);
  const [geminiError, setGeminiError] = useState<string | null>(null);
  const [showScopeMenu, setShowScopeMenu] = useState(false);
  const [searchSessions, setSearchSessions] = useState(true);
  const [searchSettings, setSearchSettings] = useState(true);
  const [settingsResults, setSettingsResults] = useState<SettingResult[]>([]);
  const settingsDebounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [folderFilter, setFolderFilter] = useState("");
  const searchDebounce = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Internal query tracks the actual input value at all times.
  // Parent's searchQuery is only updated when searchSessions is on.
  const [internalQuery, setInternalQuery] = useState("");

  const handleGeminiSearch = async () => {
    if (!geminiQuery.trim()) return;
    setGeminiLoading(true);
    setGeminiError(null);
    try {
      const res = await fetch("/api/sessions/search-gemini", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: geminiQuery }),
      });
      const data = await res.json();
      if (data.error) {
        setGeminiError(data.error);
        onGeminiResults?.([]);
      } else {
        onGeminiResults?.(
          (data.results || []).map((r: GeminiResult) => ({ ...r, query: geminiQuery }))
        );
      }
    } catch {
      setGeminiError("Search failed — check connection");
      onGeminiResults?.([]);
    } finally {
      setGeminiLoading(false);
    }
  };

  // Settings search with debounce (only when searchSettings is on)
  useEffect(() => {
    if (!searchSettings || !internalQuery.trim() || internalQuery.length < 2) {
      setSettingsResults([]);
      return;
    }
    clearTimeout(settingsDebounce.current);
    settingsDebounce.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/settings/search?q=${encodeURIComponent(internalQuery)}`);
        const data = await res.json();
        setSettingsResults(data.results || []);
      } catch {
        setSettingsResults([]);
      }
    }, 300);
    return () => {
      clearTimeout(settingsDebounce.current);
      clearTimeout(searchDebounce.current);
    };
  }, [internalQuery, searchSettings]);

  // Close menu on outside click
  useEffect(() => {
    if (!showScopeMenu) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (
        menuRef.current && !menuRef.current.contains(target) &&
        triggerRef.current && !triggerRef.current.contains(target)
      ) {
        setShowScopeMenu(false);
        setFolderFilter("");
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showScopeMenu]);

  function handleInputChange(value: string) {
    setInternalQuery(value);
    // Debounce search to avoid hammering the API on every keystroke
    clearTimeout(searchDebounce.current);
    if (searchSessions) {
      searchDebounce.current = setTimeout(() => {
        onSearchChange(value);
      }, 200);
    }
  }

  // Extract meaningful project name from project_dir
  // project_dir is the path with / replaced by - (e.g. "-Users-vova-Documents-GitHub-candidate-routing")
  // We strip common prefixes to show just the project part
  function getFolderLabel(p: ProjectListItem): string {
    let name = p.project_dir;
    // Remove everything up to and including "GitHub-"
    const ghIdx = name.indexOf("GitHub-");
    if (ghIdx >= 0) {
      name = name.slice(ghIdx + 7); // 7 = "GitHub-".length
    } else {
      // Fallback: remove leading path segments (everything up to last known dir)
      const docIdx = name.indexOf("Documents-");
      if (docIdx >= 0) name = name.slice(docIdx + 10);
    }
    return name || p.display_name;
  }

  const activeScopes = [searchSessions && "Sessions", searchSettings && "Settings"].filter(Boolean);
  const folderCount = selectedProjects?.length || 0;
  const scopeLabel = (activeScopes.length === 2 ? "All" : activeScopes[0] || "None")
    + (folderCount > 0 ? ` · ${folderCount} folder${folderCount > 1 ? "s" : ""}` : "");

  return (
    <div className="space-y-1.5">
      {/* Unified search */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          type="text"
          placeholder={
            searchSessions && searchSettings
              ? "Search titles, prompts & settings..."
              : searchSettings
                ? "Search settings..."
                : "Search titles & prompts..."
          }
          value={internalQuery}
          onChange={(e) => handleInputChange(e.target.value)}
          className="h-8 pl-8 pr-20 text-sm"
        />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
          {internalQuery && (
            <button
              onClick={() => { onSearchChange(""); setInternalQuery(""); setSettingsResults([]); }}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}

          {/* Scope selector — checkboxes */}
          <div className="relative" ref={menuRef}>
            <button
              ref={triggerRef}
              onClick={() => {
                if (!showScopeMenu && triggerRef.current) {
                  const rect = triggerRef.current.getBoundingClientRect();
                  setMenuPos({ top: rect.bottom + 4, left: rect.right });
                }
                setShowScopeMenu(!showScopeMenu);
              }}
              className={`flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] transition-colors ${
                folderCount > 0
                  ? "bg-amber-500/20 text-amber-600 dark:text-amber-400"
                  : (searchSettings && !searchSessions)
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground/40 hover:text-muted-foreground"
              }`}
              title={`Searching: ${scopeLabel}`}
            >
              {folderCount > 0 ? <Filter className="h-3 w-3" /> : <HelpCircle className="h-3 w-3" />}
              <ChevronDown className="h-2 w-2" />
            </button>
            {showScopeMenu && createPortal(
              <div
                ref={menuRef}
                className="fixed z-[9999] w-56 rounded-md border border-border shadow-lg bg-white dark:bg-neutral-900 py-1"
                style={{ top: menuPos.top, left: menuPos.left - 224 /* w-56 = 14rem = 224px, align right */ }}
              >
                <button
                  onClick={() => {
                    const next = !searchSessions;
                    setSearchSessions(next);
                    // Sync parent: push query or clear
                    onSearchChange(next ? internalQuery : "");
                  }}
                  className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-muted transition-colors flex items-center gap-2"
                >
                  <div className={`h-3 w-3 rounded-sm border flex items-center justify-center ${
                    searchSessions ? "bg-primary border-primary" : "border-muted-foreground/30"
                  }`}>
                    {searchSessions && <Check className="h-2 w-2 text-primary-foreground" />}
                  </div>
                  Sessions
                </button>
                <button
                  onClick={() => setSearchSettings(!searchSettings)}
                  className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-muted transition-colors flex items-center gap-2"
                >
                  <div className={`h-3 w-3 rounded-sm border flex items-center justify-center ${
                    searchSettings ? "bg-primary border-primary" : "border-muted-foreground/30"
                  }`}>
                    {searchSettings && <Check className="h-2 w-2 text-primary-foreground" />}
                  </div>
                  Settings
                </button>

                {/* Folders filter */}
                {projects && projects.length > 0 && onProjectFilterChange && (
                  <>
                    <div className="border-t border-border my-1" />
                    <div className="px-3 py-1 flex items-center justify-between">
                      <span className="text-[10px] text-muted-foreground/60 flex items-center gap-1">
                        <FolderOpen className="h-2.5 w-2.5" />
                        Folders
                      </span>
                      {selectedProjects && selectedProjects.length > 0 && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onProjectFilterChange([]);
                          }}
                          className="text-[9px] text-muted-foreground/40 hover:text-foreground transition-colors"
                        >
                          clear
                        </button>
                      )}
                    </div>
                    <div className="px-2 pb-1">
                      <input
                        type="text"
                        placeholder="Filter..."
                        value={folderFilter}
                        onChange={(e) => setFolderFilter(e.target.value)}
                        className="w-full h-6 px-2 text-[11px] rounded border border-border bg-transparent outline-none focus:border-primary/50 placeholder:text-muted-foreground/30"
                        autoFocus
                      />
                    </div>
                    <div className="max-h-48 overflow-y-auto">
                      {projects.filter((p) => {
                        if (!folderFilter) return true;
                        const q = folderFilter.toLowerCase();
                        return (p.custom_name || getFolderLabel(p) || "").toLowerCase().includes(q)
                          || p.project_path.toLowerCase().includes(q);
                      }).sort((a, b) => {
                        const aSelected = selectedProjects?.includes(a.project_dir) ? 0 : 1;
                        const bSelected = selectedProjects?.includes(b.project_dir) ? 0 : 1;
                        return aSelected - bSelected;
                      }).map((p) => {
                        const isSelected = selectedProjects?.includes(p.project_dir) ?? false;
                        return (
                          <button
                            key={p.project_dir}
                            onClick={() => {
                              const current = selectedProjects || [];
                              const next = isSelected
                                ? current.filter((d) => d !== p.project_dir)
                                : [...current, p.project_dir];
                              onProjectFilterChange(next);
                            }}
                            className="w-full text-left px-3 py-1 text-[11px] hover:bg-muted transition-colors flex items-center gap-2"
                          >
                            <div className={`h-3 w-3 rounded-sm border flex items-center justify-center shrink-0 ${
                              isSelected ? "bg-primary border-primary" : "border-muted-foreground/30"
                            }`}>
                              {isSelected && <Check className="h-2 w-2 text-primary-foreground" />}
                            </div>
                            <span className="truncate">{p.custom_name || getFolderLabel(p)}</span>
                            <span className="text-[9px] text-muted-foreground/40 ml-auto shrink-0">{p.session_count}</span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>,
              document.body
            )}
          </div>
        </div>
      </div>

      {/* Active folder filter chips */}
      {folderCount > 0 && projects && onProjectFilterChange && (
        <div className="flex flex-wrap gap-1 px-0.5">
          <span className="text-[9px] text-amber-600 dark:text-amber-400 flex items-center gap-0.5 mr-0.5">
            <Filter className="h-2.5 w-2.5" />
          </span>
          {selectedProjects!.map((dir) => {
            const proj = projects.find((p) => p.project_dir === dir);
            const label = proj ? (proj.custom_name || getFolderLabel(proj)) : dir;
            return (
              <span
                key={dir}
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/20"
              >
                <span className="truncate max-w-[120px]">{label}</span>
                <button
                  onClick={() => onProjectFilterChange(selectedProjects!.filter((d) => d !== dir))}
                  className="hover:text-foreground transition-colors ml-0.5"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            );
          })}
          <button
            onClick={() => onProjectFilterChange([])}
            className="text-[9px] text-muted-foreground/40 hover:text-foreground transition-colors px-1"
          >
            clear
          </button>
        </div>
      )}

      {/* Settings results (inline, below search) */}
      {searchSettings && settingsResults.length > 0 && (
        <div className="space-y-1 max-h-64 overflow-y-auto">
          <div className="text-[10px] text-muted-foreground/40 px-1 flex items-center gap-1">
            <Settings className="h-2.5 w-2.5" />
            Settings matches
          </div>
          {settingsResults.map((r) => (
            <button
              key={r.key}
              onClick={() => {
                if (r.pluginId) {
                  router.push(`/claude-sessions/settings?plugin=${r.pluginId}`);
                } else {
                  router.push("/claude-sessions/settings");
                }
              }}
              className="w-full text-left px-2.5 py-2 rounded-md hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-2">
                <code className="text-[11px] font-mono text-foreground/80">{r.key}</code>
                {r.pluginId && (
                  <span className="text-[9px] bg-primary/10 text-primary px-1 py-0.5 rounded">
                    {r.pluginId}
                  </span>
                )}
              </div>
              <p className="text-[10px] text-muted-foreground/60 mt-0.5 truncate">
                {r.description}
              </p>
            </button>
          ))}
        </div>
      )}

      {/* Gemini deep search (always visible — it's a separate feature) */}
      {searchSessions && (
        <>
          <div className="relative">
            <DollarSign className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-amber-500/70" />
            <Input
              type="text"
              placeholder="Deep search with Gemini..."
              value={geminiQuery}
              onChange={(e) => setGeminiQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleGeminiSearch();
              }}
              className="h-8 pl-8 pr-8 text-sm"
              disabled={geminiLoading}
            />
            {geminiLoading && (
              <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-amber-500/70" />
            )}
            {!geminiLoading && geminiQuery && (
              <button
                onClick={() => { setGeminiQuery(""); setGeminiError(null); onGeminiResults?.([]); }}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {geminiError && (
            <div className="text-[10px] text-destructive px-1 leading-tight">
              {geminiError}
            </div>
          )}
        </>
      )}
    </div>
  );
}
