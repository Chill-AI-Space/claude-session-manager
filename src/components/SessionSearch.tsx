"use client";

import { Input } from "@/components/ui/input";
import { Search, X, DollarSign, HelpCircle, Loader2, Settings, ChevronDown, Check } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

interface SessionSearchProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onGeminiResults?: (results: GeminiResult[]) => void;
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
    return () => clearTimeout(settingsDebounce.current);
  }, [internalQuery, searchSettings]);

  // Close menu on outside click
  useEffect(() => {
    if (!showScopeMenu) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowScopeMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showScopeMenu]);

  function handleInputChange(value: string) {
    setInternalQuery(value);
    if (searchSessions) {
      onSearchChange(value);
    }
  }

  const activeScopes = [searchSessions && "Sessions", searchSettings && "Settings"].filter(Boolean);
  const scopeLabel = activeScopes.length === 2 ? "All" : activeScopes[0] || "None";

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
              onClick={() => setShowScopeMenu(!showScopeMenu)}
              className={`flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] transition-colors ${
                searchSettings && !searchSessions
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground/40 hover:text-muted-foreground"
              }`}
              title={`Searching: ${scopeLabel}`}
            >
              <HelpCircle className="h-3 w-3" />
              <ChevronDown className="h-2 w-2" />
            </button>
            {showScopeMenu && (
              <div className="absolute right-0 top-7 z-[100] w-40 rounded-md bg-popover border border-border shadow-lg overflow-hidden">
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
              </div>
            )}
          </div>
        </div>
      </div>

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
