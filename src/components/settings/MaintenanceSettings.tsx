"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

export function MaintenanceSettings() {
  const [titleGenStatus, setTitleGenStatus] = useState<{ running: boolean; result?: string }>({ running: false });

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
        Maintenance
      </h2>
      <div className="rounded-md border border-border p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">AI Title Generation</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              Generate or regenerate titles for all sessions using Claude
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={async () => {
                setTitleGenStatus({ running: true });
                try {
                  const res = await fetch("/api/sessions/generate-titles", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ limit: 50 }),
                  });
                  const data = await res.json();
                  setTitleGenStatus({ running: false, result: data.error ? `Error: ${data.error}` : `Generated ${data.generated ?? 0} titles` });
                } catch { setTitleGenStatus({ running: false, result: "Failed" }); }
              }}
              disabled={titleGenStatus.running}
              className="px-3 py-1.5 text-xs rounded-md border border-border hover:bg-muted disabled:opacity-50 transition-colors"
            >
              {titleGenStatus.running ? <Loader2 className="h-3 w-3 animate-spin" /> : "Generate missing"}
            </button>
            <button
              onClick={async () => {
                setTitleGenStatus({ running: true });
                try {
                  const res = await fetch("/api/sessions/generate-titles", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ limit: 50, force: true }),
                  });
                  const data = await res.json();
                  setTitleGenStatus({ running: false, result: data.error ? `Error: ${data.error}` : `Regenerated ${data.generated ?? 0} titles` });
                } catch { setTitleGenStatus({ running: false, result: "Failed" }); }
              }}
              disabled={titleGenStatus.running}
              className="px-3 py-1.5 text-xs rounded-md border border-border hover:bg-muted disabled:opacity-50 transition-colors"
            >
              {titleGenStatus.running ? <Loader2 className="h-3 w-3 animate-spin" /> : "Regenerate all"}
            </button>
          </div>
        </div>
        {titleGenStatus.result && (
          <div className="text-xs text-muted-foreground">{titleGenStatus.result}</div>
        )}
      </div>
    </div>
  );
}
