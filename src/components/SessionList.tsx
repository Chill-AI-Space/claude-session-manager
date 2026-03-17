"use client";

import { SessionListItem } from "@/lib/types";
import { SessionListItemComponent } from "./SessionListItem";
import { GeminiResult } from "./SessionSearch";
import { Loader2 } from "lucide-react";
import { useParams } from "next/navigation";
import { useState, useEffect, useMemo, useRef, useCallback } from "react";

interface SessionListProps {
  sessions: SessionListItem[];
  loading: boolean;
  geminiResults?: GeminiResult[];
  onArchive?: (sessionId: string) => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}

export function SessionList({ sessions, loading, geminiResults, onArchive, hasMore, loadingMore, onLoadMore }: SessionListProps) {
  const params = useParams();
  const currentSessionId = params?.sessionId as string | undefined;

  // Tick every 10s — bucket to 10s granularity so React.memo on items actually fires rarely
  const [nowRaw, setNowRaw] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowRaw(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);
  const now = Math.floor(nowRaw / 10_000) * 10_000; // 10s bucket

  // Memoize Gemini-derived maps — only recompute when results change
  const { displaySessions, snippetMap, queryMap } = useMemo(() => {
    if (!geminiResults?.length) {
      return { displaySessions: sessions, snippetMap: undefined, queryMap: undefined };
    }
    const geminiIds = new Set(geminiResults.map((r) => r.session_id));
    const geminiOrder = new Map(geminiResults.map((r, i) => [r.session_id, i]));
    const snippetMap = new Map(geminiResults.map((r) => [r.session_id, r.snippet]));
    const queryMap = new Map(
      geminiResults.filter((r) => r.query).map((r) => [r.session_id, r.query!])
    );
    const displaySessions = sessions
      .filter((s) => geminiIds.has(s.session_id))
      .sort((a, b) => (geminiOrder.get(a.session_id) ?? 0) - (geminiOrder.get(b.session_id) ?? 0));
    return { displaySessions, snippetMap, queryMap };
  }, [geminiResults, sessions]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (displaySessions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs p-4 text-center">
        No sessions found
      </div>
    );
  }

  // IntersectionObserver for auto-loading more sessions on scroll
  const sentinelRef = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;

  useEffect(() => {
    if (!hasMore || !sentinelRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) onLoadMoreRef.current?.();
      },
      { rootMargin: "200px" }
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [hasMore, displaySessions.length]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="py-1">
        {displaySessions.map((session, i) => {
          const prevProject = i > 0 ? displaySessions[i - 1].project_dir : null;
          const showLabel = session.project_dir !== prevProject;
          return (
            <div key={session.session_id}>
              {showLabel && (
                <div className="px-3 pt-2 pb-1 text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider sticky top-0 bg-sidebar/95 backdrop-blur-sm z-10">
                  {session.display_name}
                </div>
              )}
              <SessionListItemComponent
                session={session}
                selected={session.session_id === currentSessionId}
                snippet={snippetMap?.get(session.session_id)}
                highlightQuery={queryMap?.get(session.session_id)}
                now={now}
                onArchive={onArchive}
              />
            </div>
          );
        })}
        {/* Sentinel for infinite scroll */}
        {hasMore && (
          <div ref={sentinelRef} className="flex items-center justify-center py-3">
            {loadingMore ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            ) : (
              <button
                onClick={onLoadMore}
                className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                Load more...
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
