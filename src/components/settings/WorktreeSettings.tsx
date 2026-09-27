"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { SettingsComponentProps } from "./types";

interface WorktreeEntry {
  dir: string;
  branch: string;
  removable: boolean;
  reason: string;
  removed?: boolean;
}

export function WorktreeSettings({ settings, onUpdate }: SettingsComponentProps) {
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<WorktreeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(method: "GET" | "POST") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/worktrees", { method });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      setEntries(data.worktrees);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
        Session Worktrees
      </h2>

      <label className="flex items-start gap-3 cursor-pointer group">
        <input
          type="checkbox"
          checked={settings.sessions_worktree_default === "true"}
          onChange={(e) => onUpdate("sessions_worktree_default", e.target.checked ? "true" : "false")}
          className="mt-1 h-4 w-4 rounded border-input accent-primary"
        />
        <div className="space-y-1">
          <div className="text-sm font-medium">Start each new session in its own git worktree</div>
          <div className="text-xs text-muted-foreground leading-relaxed">
            When the folder is a git repo, the session gets a separate checkout in{" "}
            <code className="font-mono bg-muted px-1 rounded">../.worktrees/&lt;repo&gt;/</code> on a new{" "}
            <code className="font-mono bg-muted px-1 rounded">session/…</code> branch, so parallel sessions
            don&apos;t trample each other&apos;s files. Applies to sessions started here; sub-sessions spawned
            via the API always get a worktree unless they pass{" "}
            <code className="font-mono bg-muted px-1 rounded">&quot;worktree&quot;: false</code>.
            node_modules and .env are not copied into the worktree.
          </div>
        </div>
      </label>

      <div className="rounded-md border border-border p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium">Clean up worktrees</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              Removes only worktrees that are clean, have no unpushed commits and no running session.
            </div>
          </div>
          <div className="flex gap-2 shrink-0">
            <button
              onClick={() => run("GET")}
              disabled={busy}
              className="px-3 py-1.5 text-xs rounded-md border border-border hover:bg-muted disabled:opacity-50 transition-colors"
            >
              List
            </button>
            <button
              onClick={() => run("POST")}
              disabled={busy}
              className="px-3 py-1.5 text-xs rounded-md border border-border hover:bg-muted disabled:opacity-50 transition-colors"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : "Clean up"}
            </button>
          </div>
        </div>
        {error && <div className="text-xs text-destructive">{error}</div>}
        {entries && entries.length === 0 && (
          <div className="text-xs text-muted-foreground">No session worktrees.</div>
        )}
        {entries && entries.length > 0 && (
          <ul className="space-y-1.5">
            {entries.map((e) => (
              <li key={e.dir} className="text-xs">
                <span className={e.removed ? "text-green-600 dark:text-green-400" : e.removable ? "" : "text-muted-foreground"}>
                  {e.removed ? "removed" : e.removable ? "can remove" : "kept"}
                </span>{" "}
                <code className="font-mono">{e.branch}</code>
                <div className="text-muted-foreground/70 break-all">{e.dir} — {e.reason}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
