"use client";

import { Input } from "@/components/ui/input";
import { Search, X, DollarSign, HelpCircle, Loader2 } from "lucide-react";
import { useState, useRef } from "react";

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

export function SessionSearch({
  searchQuery,
  onSearchChange,
  onGeminiResults,
}: SessionSearchProps) {
  const [geminiQuery, setGeminiQuery] = useState("");
  const [geminiLoading, setGeminiLoading] = useState(false);
  const [geminiError, setGeminiError] = useState<string | null>(null);
  const [showHint, setShowHint] = useState(false);

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

  return (
    <div className="space-y-1.5">
      {/* Basic search */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Search titles & prompts..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="h-8 pl-8 pr-14 text-sm"
        />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
          {searchQuery && (
            <button
              onClick={() => onSearchChange("")}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          <div className="relative">
            <button
              onMouseEnter={() => setShowHint(true)}
              onMouseLeave={() => setShowHint(false)}
              className="text-muted-foreground/40 hover:text-muted-foreground"
            >
              <HelpCircle className="h-3 w-3" />
            </button>
            {showHint && (
              <div className="absolute right-0 top-5 z-50 w-48 rounded bg-popover border border-border p-2 text-[10px] text-muted-foreground shadow-md leading-relaxed">
                Searches in titles, first prompt, last message, and session ID
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Gemini deep search */}
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

    </div>
  );
}
