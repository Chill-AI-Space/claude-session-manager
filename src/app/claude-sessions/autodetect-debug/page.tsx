"use client";

import { useEffect, useState, useCallback } from "react";
import { Loader2, RefreshCw, Trash2, CheckCircle2, XCircle, Minus, ChevronDown, ChevronRight, Sparkles, Search } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ScoreBreakdown {
  name: number;
  folder: number;
  dir: number;
  titles: number;
  recency: number;
}

interface KeywordEntry {
  name: string;
  path: string;
  score: number;
  breakdown?: ScoreBreakdown;
}

interface GeminiEntry {
  name: string;
  path: string;
}

interface LogEntry {
  id: number;
  created_at: string;
  prompt: string;
  chosen_path: string;
  chosen_name: string | null;
  keyword_rank: number | null;
  gemini_rank: number | null;
  keyword_top5: string | null;
  gemini_top5: string | null;
  keyword_all_scores: string | null;
  gemini_raw: string | null;
  gemini_method: string | null;
  total_projects: number;
}

function RankBadge({ rank, method }: { rank: number | null; method: string }) {
  if (rank === null) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-400">
        <XCircle className="h-3 w-3" /> miss
      </span>
    );
  }
  if (rank === 1) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400">
        <CheckCircle2 className="h-3 w-3" /> #{rank} {method}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400">
      <Minus className="h-3 w-3" /> #{rank} {method}
    </span>
  );
}

function ScoreTable({ scores }: { scores: KeywordEntry[] }) {
  return (
    <div className="mt-2 rounded border border-border overflow-hidden">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="bg-muted/30 text-muted-foreground">
            <th className="text-left px-2 py-1 font-medium">#</th>
            <th className="text-left px-2 py-1 font-medium">Project</th>
            <th className="text-right px-2 py-1 font-medium">Score</th>
            {scores[0]?.breakdown && (
              <>
                <th className="text-right px-2 py-1 font-medium">Name</th>
                <th className="text-right px-2 py-1 font-medium">Folder</th>
                <th className="text-right px-2 py-1 font-medium">Dir</th>
                <th className="text-right px-2 py-1 font-medium">Titles</th>
                <th className="text-right px-2 py-1 font-medium">Recency</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {scores.map((s, i) => (
            <tr key={i} className={`border-t border-border/50 ${i < 5 ? "bg-card" : "bg-card/50 text-muted-foreground"}`}>
              <td className="px-2 py-0.5 text-muted-foreground/60">{i + 1}</td>
              <td className="px-2 py-0.5 truncate max-w-[200px]" title={s.path}>{s.name}</td>
              <td className="px-2 py-0.5 text-right font-mono">{s.score}</td>
              {s.breakdown && (
                <>
                  <td className="px-2 py-0.5 text-right font-mono">{s.breakdown.name || ""}</td>
                  <td className="px-2 py-0.5 text-right font-mono">{s.breakdown.folder || ""}</td>
                  <td className="px-2 py-0.5 text-right font-mono">{s.breakdown.dir || ""}</td>
                  <td className="px-2 py-0.5 text-right font-mono">{s.breakdown.titles || ""}</td>
                  <td className="px-2 py-0.5 text-right font-mono">{s.breakdown.recency || ""}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LogRow({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false);

  const keywordTop5: KeywordEntry[] = (() => {
    try { return JSON.parse(entry.keyword_top5 || "[]"); } catch { return []; }
  })();

  const geminiTop5: GeminiEntry[] = (() => {
    try { return JSON.parse(entry.gemini_top5 || "[]"); } catch { return []; }
  })();

  const allScores: KeywordEntry[] = (() => {
    try { return JSON.parse(entry.keyword_all_scores || "[]"); } catch { return []; }
  })();

  const isHit = entry.keyword_rank !== null || entry.gemini_rank !== null;
  const bestRank = Math.min(entry.keyword_rank ?? 999, entry.gemini_rank ?? 999);

  return (
    <div className={`border rounded-lg overflow-hidden ${isHit ? "border-border" : "border-red-500/30"}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/30 transition-colors"
      >
        {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <span className="text-[11px] text-muted-foreground/60 shrink-0 w-[110px]">
          {new Date(entry.created_at + "Z").toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
        </span>
        <span className="text-[12px] truncate flex-1 min-w-0">{entry.prompt}</span>
        <span className="text-[11px] text-muted-foreground truncate max-w-[120px] shrink-0">
          → {entry.chosen_name || entry.chosen_path.split(/[\\/]/).pop()}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          <RankBadge rank={entry.keyword_rank} method="kw" />
          {entry.gemini_method === "gemini" && (
            <RankBadge rank={entry.gemini_rank} method="ai" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t border-border/50 bg-muted/10">
          <div className="pt-2 space-y-1">
            <p className="text-[11px] text-muted-foreground">
              <span className="font-medium">Prompt:</span> {entry.prompt}
            </p>
            <p className="text-[11px] text-muted-foreground">
              <span className="font-medium">Chosen:</span> {entry.chosen_path}
            </p>
            <p className="text-[11px] text-muted-foreground">
              <span className="font-medium">Total projects:</span> {entry.total_projects}
            </p>
          </div>

          {/* Keyword results */}
          <div>
            <p className="text-[11px] font-medium text-muted-foreground flex items-center gap-1">
              <Search className="h-3 w-3" /> Keyword Top 5
              {entry.keyword_rank !== null && (
                <span className="text-emerald-400 font-normal"> — chosen at #{entry.keyword_rank}</span>
              )}
              {entry.keyword_rank === null && (
                <span className="text-red-400 font-normal"> — chosen NOT in top 5</span>
              )}
            </p>
            <ScoreTable scores={keywordTop5} />
          </div>

          {/* Gemini results */}
          {entry.gemini_method === "gemini" && (
            <div>
              <p className="text-[11px] font-medium text-muted-foreground flex items-center gap-1">
                <Sparkles className="h-3 w-3" /> Gemini Results
                {entry.gemini_rank !== null && (
                  <span className="text-emerald-400 font-normal"> — chosen at #{entry.gemini_rank}</span>
                )}
                {entry.gemini_rank === null && (
                  <span className="text-red-400 font-normal"> — chosen NOT in results</span>
                )}
              </p>
              <div className="mt-1 space-y-0.5">
                {geminiTop5.map((g, i) => (
                  <div key={i} className="text-[11px] flex items-center gap-1.5">
                    <span className="text-muted-foreground/50 w-4">{i + 1}.</span>
                    <span className={g.path === entry.chosen_path ? "text-emerald-400" : ""}>{g.name}</span>
                  </div>
                ))}
              </div>
              {entry.gemini_raw && (
                <p className="text-[10px] text-muted-foreground/50 mt-1">
                  Raw: <code className="bg-muted/50 px-1 rounded">{entry.gemini_raw}</code>
                </p>
              )}
            </div>
          )}

          {/* Full keyword scores (if more than 5 projects) */}
          {allScores.length > 5 && (
            <details className="text-[11px]">
              <summary className="text-muted-foreground cursor-pointer hover:text-foreground">
                All {allScores.length} project scores
              </summary>
              <ScoreTable scores={allScores} />
            </details>
          )}
        </div>
      )}
    </div>
  );
}

export default function AutodetectDebugPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/autodetect-log?limit=100");
      const data = await res.json();
      setLogs(data.entries || data);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleClear = async () => {
    if (!confirm("Clear all autodetect debug logs?")) return;
    await fetch("/api/autodetect-log", { method: "DELETE" });
    setLogs([]);
  };

  // Stats
  const total = logs.length;
  const keywordHits = logs.filter(l => l.keyword_rank !== null).length;
  const geminiHits = logs.filter(l => l.gemini_rank !== null && l.gemini_method === "gemini").length;
  const geminiTotal = logs.filter(l => l.gemini_method === "gemini").length;
  const anyHit = logs.filter(l => l.keyword_rank !== null || l.gemini_rank !== null).length;
  const rank1 = logs.filter(l => (l.keyword_rank === 1) || (l.gemini_rank === 1)).length;

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-sm font-semibold">Autodetect Debug</h1>
            <p className="text-[11px] text-muted-foreground">
              Every session start runs autodetect silently and logs whether the chosen folder would be detected.
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            </Button>
            <Button variant="ghost" size="sm" onClick={handleClear} disabled={logs.length === 0}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* Stats */}
        {total > 0 && (
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            <span>{total} sessions logged</span>
            <span className="text-border">|</span>
            <span>
              Hit rate: <span className={anyHit / total > 0.8 ? "text-emerald-400" : "text-amber-400"}>
                {Math.round((anyHit / total) * 100)}%
              </span> ({anyHit}/{total})
            </span>
            <span className="text-border">|</span>
            <span>Rank #1: {Math.round((rank1 / total) * 100)}%</span>
            <span className="text-border">|</span>
            <span>KW: {keywordHits}/{total}</span>
            {geminiTotal > 0 && (
              <>
                <span className="text-border">|</span>
                <span>Gemini: {geminiHits}/{geminiTotal}</span>
              </>
            )}
          </div>
        )}

        {loading && logs.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : logs.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground text-sm">
            No autodetect logs yet. Start a session to begin logging.
          </div>
        ) : (
          <div className="space-y-1.5">
            {logs.map(entry => (
              <LogRow key={entry.id} entry={entry} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
