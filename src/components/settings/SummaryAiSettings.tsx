"use client";

import { SettingsComponentProps } from "./types";

export function SummaryAiSettings({ settings, onUpdate, savedKey }: SettingsComponentProps) {
  return (
    <div className="space-y-6">
      <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
        Summary AI
      </h2>
      <p className="text-xs text-muted-foreground">
        AI models used for session summary generation. Summaries use direct API calls (no CLI sessions spawned).
        Long transcripts are automatically split into chunks (map/reduce).
      </p>

      {/* One-shot summary model */}
      <div className="space-y-1">
        <div className="text-sm font-medium">Summary model</div>
        <p className="text-xs text-muted-foreground">
          Model for generating full session summaries. Any OpenAI, Anthropic, or Google model.
        </p>
        <input
          type="text"
          value={settings.summary_model || "gpt-4o-mini"}
          onChange={(e) => onUpdate("summary_model", e.target.value)}
          onBlur={(e) => onUpdate("summary_model", e.target.value.trim())}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          placeholder="gpt-4o-mini"
          className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {/* Incremental summary model */}
      <div className="space-y-1">
        <div className="text-sm font-medium">Incremental summary model</div>
        <p className="text-xs text-muted-foreground">
          Model for incremental summaries (updated as session progresses). Can be cheaper/faster.
        </p>
        <input
          type="text"
          value={settings.summary_incremental_model || "gemini-2.5-flash"}
          onChange={(e) => onUpdate("summary_incremental_model", e.target.value)}
          onBlur={(e) => onUpdate("summary_incremental_model", e.target.value.trim())}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          placeholder="gemini-2.5-flash"
          className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {/* Learnings model */}
      <div className="space-y-1">
        <div className="text-sm font-medium">Learnings model</div>
        <p className="text-xs text-muted-foreground">
          Model for extracting structured learnings from sessions. Uses direct API (no CLI sessions spawned).
        </p>
        <input
          type="text"
          value={settings.learnings_model || "gpt-4o-mini"}
          onChange={(e) => onUpdate("learnings_model", e.target.value)}
          onBlur={(e) => onUpdate("learnings_model", e.target.value.trim())}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          placeholder="gpt-4o-mini"
          className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {/* Auto-generate toggles */}
      <div className="space-y-3">
        <div className="text-sm font-medium">Auto-generation</div>
        <p className="text-xs text-muted-foreground">
          Controls whether summaries and learnings are generated automatically when you open a session.
          When disabled, you can still generate them manually via the refresh button.
        </p>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.auto_generate_summary !== "false"}
            onChange={(e) => onUpdate("auto_generate_summary", e.target.checked ? "true" : "false")}
            className="rounded border-input"
          />
          <span className="text-sm">Auto-generate summary on page load</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.auto_generate_learnings !== "false"}
            onChange={(e) => onUpdate("auto_generate_learnings", e.target.checked ? "true" : "false")}
            className="rounded border-input"
          />
          <span className="text-sm">Auto-generate learnings on page load</span>
        </label>
      </div>

      {/* API Keys */}
      <div className="space-y-3">
        <div className="text-sm font-medium">API Keys</div>
        <p className="text-xs text-muted-foreground">
          Only the key for your chosen model&apos;s provider is required. Keys are stored locally in settings.json.
        </p>
        {[
          { key: "openai_api_key", label: "OpenAI", placeholder: "sk-..." },
          { key: "anthropic_api_key", label: "Anthropic", placeholder: "sk-ant-..." },
          { key: "google_ai_api_key", label: "Google AI (Gemini)", placeholder: "AIza..." },
        ].map(({ key, label, placeholder }) => (
          <div key={key} className="space-y-1">
            <label className="text-xs text-muted-foreground">{label}</label>
            <input
              type="password"
              value={settings[key] || ""}
              onChange={(e) => onUpdate(key, e.target.value)}
              onBlur={(e) => onUpdate(key, e.target.value.trim())}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              placeholder={placeholder}
              className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
