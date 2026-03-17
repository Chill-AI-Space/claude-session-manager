"use client";

import { Check } from "lucide-react";
import { SettingsComponentProps } from "./types";

export function SearchSettings({ settings, onUpdate, savedKey }: SettingsComponentProps) {
  return (
    <div className="space-y-6">
      {/* Deep Search */}
      <div className="space-y-4">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Deep Search
        </h2>
        <div className="space-y-2">
          <div className="text-sm font-medium">Vector pre-filter limit</div>
          <div className="text-xs text-muted-foreground leading-relaxed mb-2">
            How many sessions the vector search narrows down before sending to
            Gemini for semantic ranking. Lower values = faster + cheaper,
            higher = more thorough. Embeddings are generated automatically.
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={5}
              max={100}
              step={5}
              value={settings.vector_search_top_k || "20"}
              onChange={(e) => onUpdate("vector_search_top_k", e.target.value)}
              onBlur={(e) => {
                const val = Math.max(5, Math.min(100, parseInt(e.target.value) || 20));
                onUpdate("vector_search_top_k", val.toString());
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              className="w-20 px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <span className="text-xs text-muted-foreground">sessions</span>
            {savedKey === "vector_search_top_k" && (
              <span className="flex items-center gap-1 text-xs text-green-500 animate-in fade-in duration-200">
                <Check className="h-3 w-3" />
                Saved
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Folder Browser */}
      <div className="space-y-4">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Folder Browser
        </h2>
        <div className="space-y-2">
          <div className="text-sm font-medium">Start browsing from</div>
          <div className="text-xs text-muted-foreground leading-relaxed mb-2">
            The folder tree in &quot;Start session&quot; will open at this path
            instead of the home directory. Use a path like{" "}
            <code className="px-1 py-0.5 bg-muted rounded text-[11px]">~/Documents/GitHub</code>{" "}
            to jump straight to your projects.
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={settings.browse_start_path || ""}
              onChange={(e) => onUpdate("browse_start_path", e.target.value)}
              onBlur={(e) => {
                const val = e.target.value.trim();
                onUpdate("browse_start_path", val);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              placeholder="~ (home directory)"
              className="flex-1 px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {savedKey === "browse_start_path" && (
              <span className="flex items-center gap-1 text-xs text-green-500 animate-in fade-in duration-200">
                <Check className="h-3 w-3" />
                Saved
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
