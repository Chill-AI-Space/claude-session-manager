"use client";

import { SessionListItem } from "@/lib/types";
import { SessionListItemComponent } from "./SessionListItem";
import { GeminiResult } from "./SessionSearch";
import { Loader2 } from "lucide-react";
import { useParams } from "next/navigation";

interface SessionListProps {
  sessions: SessionListItem[];
  loading: boolean;
  geminiResults?: GeminiResult[];
}

export function SessionList({ sessions, loading, geminiResults }: SessionListProps) {
  const params = useParams();
  const currentSessionId = params?.sessionId as string | undefined;

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // If Gemini results are active, filter and reorder sessions
  let displaySessions = sessions;
  const snippetMap = new Map<string, string>();

  if (geminiResults && geminiResults.length > 0) {
    const geminiIds = new Set(geminiResults.map((r) => r.session_id));
    const geminiOrder = new Map(geminiResults.map((r, i) => [r.session_id, i]));
    geminiResults.forEach((r) => snippetMap.set(r.session_id, r.snippet));

    displaySessions = sessions
      .filter((s) => geminiIds.has(s.session_id))
      .sort((a, b) => (geminiOrder.get(a.session_id) ?? 0) - (geminiOrder.get(b.session_id) ?? 0));
  }

  if (displaySessions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs p-4 text-center">
        No sessions found
      </div>
    );
  }

  // Group by project
  const grouped = new Map<string, SessionListItem[]>();
  for (const session of displaySessions) {
    const key = session.project_dir;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(session);
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="py-1">
        {Array.from(grouped.entries()).map(([projectDir, projectSessions]) => (
          <div key={projectDir} className="mb-0.5">
            <div className="px-3 py-1.5 text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider sticky top-0 bg-card/95 backdrop-blur-sm z-10">
              {projectSessions[0].display_name}
              <span className="ml-1 opacity-50">
                {projectSessions.length}
              </span>
            </div>
            {projectSessions.map((session) => (
              <SessionListItemComponent
                key={session.session_id}
                session={session}
                selected={session.session_id === currentSessionId}
                snippet={snippetMap.get(session.session_id)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
