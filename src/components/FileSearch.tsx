"use client";

import { useState, useCallback, useRef } from "react";
import { Search, FileText, Code2, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface FileSearchResult {
  path: string;
  name: string;
  ext: string;
  dir: string;
  line?: number;
  preview?: string;
  mode: "name" | "content";
}

interface FileSearchProps {
  roots: string[];
  onSelect: (result: FileSearchResult) => void;
  onClear: () => void;
  hasResults: boolean;
}

function useDebounce<T extends (...args: Parameters<T>) => void>(fn: T, delay: number): T {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return useCallback(
    ((...args: Parameters<T>) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => fn(...args), delay);
    }) as T,
    [fn, delay]
  );
}

export function FileSearch({ roots, onSelect, onClear, hasResults }: FileSearchProps) {
  const [nameQuery, setNameQuery] = useState("");
  const [contentQuery, setContentQuery] = useState("");
  const [nameResults, setNameResults] = useState<FileSearchResult[]>([]);
  const [contentResults, setContentResults] = useState<FileSearchResult[]>([]);
  const [loadingName, setLoadingName] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);
  const [activeMode, setActiveMode] = useState<"name" | "content" | null>(null);

  const searchName = useCallback(async (q: string) => {
    if (!q.trim() || !roots.length) {
      setNameResults([]);
      if (!contentQuery.trim()) { setActiveMode(null); onClear(); }
      return;
    }
    setLoadingName(true);
    setActiveMode("name");
    try {
      const res = await fetch(`/api/files/search?q=${encodeURIComponent(q)}&roots=${encodeURIComponent(JSON.stringify(roots))}`);
      const data = await res.json();
      setNameResults((data.results ?? []).map((r: Omit<FileSearchResult, "mode">) => ({ ...r, mode: "name" as const })));
    } catch {
      setNameResults([]);
    } finally {
      setLoadingName(false);
    }
  }, [roots, contentQuery, onClear]);

  const searchContent = useCallback(async (q: string) => {
    if (!q.trim() || !roots.length) {
      setContentResults([]);
      if (!nameQuery.trim()) { setActiveMode(null); onClear(); }
      return;
    }
    setLoadingContent(true);
    setActiveMode("content");
    try {
      const res = await fetch("/api/files/search-content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, roots }),
      });
      const data = await res.json();
      setContentResults(
        (data.results ?? []).map((r: { path: string; line: number; preview: string }) => ({
          path: r.path,
          name: r.path.split(/[\\/]/).pop() ?? r.path,
          ext: (r.path.lastIndexOf(".") > 0 ? r.path.slice(r.path.lastIndexOf(".") + 1) : "").toLowerCase(),
          dir: r.path.slice(0, r.path.search(/[\\/][^\\/]*$/)),
          line: r.line,
          preview: r.preview,
          mode: "content" as const,
        }))
      );
    } catch {
      setContentResults([]);
    } finally {
      setLoadingContent(false);
    }
  }, [roots, nameQuery, onClear]);

  const debouncedSearchName = useDebounce(searchName, 300);
  const debouncedSearchContent = useDebounce(searchContent, 500);

  const clearAll = () => {
    setNameQuery("");
    setContentQuery("");
    setNameResults([]);
    setContentResults([]);
    setActiveMode(null);
    onClear();
  };

  const isActive = nameQuery.trim() || contentQuery.trim();
  const results = activeMode === "content" ? contentResults : nameResults;
  const loading = activeMode === "content" ? loadingContent : loadingName;

  return (
    <div className="flex flex-col gap-1.5">
      {/* Filename search */}
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/50 pointer-events-none" />
        <input
          type="text"
          value={nameQuery}
          onChange={(e) => {
            setNameQuery(e.target.value);
            setActiveMode("name");
            debouncedSearchName(e.target.value);
          }}
          placeholder="Search filenames…"
          className="w-full pl-6 pr-6 py-1 text-xs bg-muted/30 border border-input rounded focus:outline-none focus:ring-1 focus:ring-ring"
        />
        {nameQuery && (
          <button onClick={() => { setNameQuery(""); setNameResults([]); if (!contentQuery.trim()) { setActiveMode(null); onClear(); } }}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground">
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Content search */}
      <div className="relative">
        <Code2 className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/50 pointer-events-none" />
        <input
          type="text"
          value={contentQuery}
          onChange={(e) => {
            setContentQuery(e.target.value);
            setActiveMode("content");
            debouncedSearchContent(e.target.value);
          }}
          placeholder="Search file contents…"
          className="w-full pl-6 pr-6 py-1 text-xs bg-muted/30 border border-input rounded focus:outline-none focus:ring-1 focus:ring-ring"
        />
        {contentQuery && (
          <button onClick={() => { setContentQuery(""); setContentResults([]); if (!nameQuery.trim()) { setActiveMode(null); onClear(); } }}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground">
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Results */}
      {isActive && (
        <div className="mt-0.5">
          {loading ? (
            <div className="flex items-center gap-1.5 px-2 py-2 text-[10px] text-muted-foreground/50">
              <Loader2 className="h-3 w-3 animate-spin" />
              Searching…
            </div>
          ) : results.length === 0 ? (
            <div className="px-2 py-2 text-[10px] text-muted-foreground/40">No results</div>
          ) : (
            <div className="space-y-px">
              <div className="px-2 text-[10px] text-muted-foreground/40 mb-1">
                {results.length} result{results.length !== 1 ? "s" : ""}
                {isActive && <button onClick={clearAll} className="ml-2 hover:text-muted-foreground underline underline-offset-2">Clear</button>}
              </div>
              {results.map((r, i) => (
                <button
                  key={`${r.path}-${r.line ?? i}`}
                  onClick={() => onSelect(r)}
                  className="w-full text-left px-2 py-1.5 rounded hover:bg-accent/50 transition-colors"
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <FileText className="h-3 w-3 text-muted-foreground/50 shrink-0" />
                    <span className="text-xs font-medium truncate">{r.name}</span>
                    {r.line && <span className="text-[10px] text-muted-foreground/50 shrink-0">:{r.line}</span>}
                  </div>
                  <div className="text-[10px] text-muted-foreground/40 truncate pl-4.5 mt-0.5">{r.dir}</div>
                  {r.preview && (
                    <div className={cn("text-[10px] text-muted-foreground/60 mt-0.5 pl-4.5 font-mono truncate")}>
                      {r.preview}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
