"use client";

import { SessionListItem } from "@/lib/types";
import { SessionListItemComponent } from "./SessionListItem";
import { GeminiResult } from "./SessionSearch";
import { Loader2 } from "lucide-react";
import { useParams } from "next/navigation";
import { useState, useEffect, useMemo } from "react";
import { Virtuoso } from "react-virtuoso";

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

  // Group sessions by project_dir for sticky headers
  const groupData = useMemo(() => {
    const groups: Array<{ projectDir: string; displayName: string; sessions: SessionListItem[] }> = [];
    let currentProjectDir: string | null = null;
    let currentGroup: SessionListItem[] = [];

    for (const session of displaySessions) {
      if (session.project_dir !== currentProjectDir) {
        if (currentGroup.length > 0) {
          groups.push({ projectDir: currentProjectDir!, displayName: currentGroup[0].display_name, sessions: currentGroup });
        }
        currentProjectDir = session.project_dir;
        currentGroup = [session];
      } else {
        currentGroup.push(session);
      }
    }
    if (currentGroup.length > 0) {
      groups.push({ projectDir: currentProjectDir!, displayName: currentGroup[0].display_name, sessions: currentGroup });
    }

    return groups;
  }, [displaySessions]);

  // Flat list of headers + sessions, built once per data change so Virtuoso's itemContent
  // is an O(1) lookup (was an O(n) walk per rendered row) and its `data` prop is stable.
  const flatItems = useMemo(() => {
    const items: Array<{ type: "header"; displayName: string } | { type: "session"; session: SessionListItem }> = [];
    for (const group of groupData) {
      items.push({ type: "header", displayName: group.displayName });
      for (const session of group.sessions) items.push({ type: "session", session });
    }
    return items;
  }, [groupData]);

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

  return (
    <Virtuoso
      style={{ flex: 1, overflow: "auto" }}
      data={flatItems}
      itemContent={(index, item) => {
        if (item.type === "header") {
          return (
            <div key={`header-${index}`} className="px-3 pt-2 pb-1 text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider sticky top-0 bg-sidebar/95 backdrop-blur-sm z-10">
              {item.displayName}
            </div>
          );
        }

        const session = item.session;
        return (
          <SessionListItemComponent
            key={session.session_id}
            session={session}
            selected={session.session_id === currentSessionId}
            snippet={snippetMap?.get(session.session_id)}
            highlightQuery={queryMap?.get(session.session_id)}
            now={now}
            onArchive={onArchive}
          />
        );
      }}
      endReached={() => {
        if (hasMore && !loadingMore && onLoadMore) {
          onLoadMore();
        }
      }}
      components={{
        Footer: (hasMore || loadingMore) ? () => (
          <div className="flex items-center justify-center py-3">
            {loadingMore
              ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              : <span className="text-[11px] text-muted-foreground/40">↓ more</span>
            }
          </div>
        ) : undefined,
      }}
    />
  );
}
