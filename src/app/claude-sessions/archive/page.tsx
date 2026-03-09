"use client";

import { useState, useEffect } from "react";
import { Loader2, ArchiveRestore } from "lucide-react";
import Link from "next/link";

interface ArchivedSession {
  session_id: string;
  project_path: string;
  first_prompt: string | null;
  generated_title: string | null;
  custom_name: string | null;
  message_count: number;
  modified_at: string;
  created_at: string;
}

function getTitle(s: ArchivedSession): string {
  if (s.custom_name) return s.custom_name;
  if (s.generated_title) return s.generated_title;
  if (s.first_prompt) {
    const line = s.first_prompt.split("\n")[0].trim();
    return line.length > 80 ? line.slice(0, 80) + "..." : line;
  }
  return s.session_id.slice(0, 8) + "...";
}

export default function ArchivePage() {
  const [sessions, setSessions] = useState<ArchivedSession[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    const res = await fetch("/api/sessions?archived=true&sort=modified&limit=500");
    const data = await res.json();
    setSessions(data.sessions ?? []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function unarchive(sessionId: string) {
    setSessions((prev) => prev.filter((s) => s.session_id !== sessionId));
    await fetch(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: false }),
    });
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-3xl mx-auto">
      <h1 className="text-lg font-semibold mb-1">Archive</h1>
      <p className="text-xs text-muted-foreground mb-4">
        {sessions.length} archived session{sessions.length !== 1 ? "s" : ""}
      </p>

      {sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground mt-8 text-center">No archived sessions</p>
      ) : (
        <div className="space-y-1">
          {sessions.map((s) => (
            <div
              key={s.session_id}
              className="flex items-center gap-3 px-3 py-2 rounded hover:bg-accent/50 group"
            >
              <Link
                href={`/claude-sessions/${s.session_id}`}
                className="flex-1 min-w-0"
              >
                <div className="text-sm truncate">{getTitle(s)}</div>
                <div className="text-[10px] text-muted-foreground/60">
                  {s.project_path.split(/[\\/]/).pop()} &middot; {s.message_count} msgs &middot; {new Date(s.modified_at).toLocaleDateString()}
                </div>
              </Link>
              <button
                onClick={() => unarchive(s.session_id)}
                className="p-1.5 rounded opacity-0 group-hover:opacity-100 hover:bg-muted text-muted-foreground/50 hover:text-muted-foreground transition-all"
                title="Restore from archive"
              >
                <ArchiveRestore className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
