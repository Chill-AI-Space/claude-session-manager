"use client";

import { useEffect, useState } from "react";
import { SettingsComponentProps } from "./types";
import { ModelSelector } from "./ModelSelector";
import { EffectiveModelBadge } from "@/components/EffectiveModelBadge";
import { AlertTriangle, Info } from "lucide-react";

interface EffectiveModelInfo {
  reportedModel: string | null;
  effectiveModel: string;
  isOverridden: boolean;
  provider: string | null;
  label: string;
  shortLabel: string;
}

export function SummaryAiSettings({ settings, onUpdate, savedKey }: SettingsComponentProps) {
  const [effectiveModel, setEffectiveModel] = useState<EffectiveModelInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchEffectiveModel = async () => {
      try {
        const reportedModel = settings.claude_model || "claude-sonnet-4-6";
        const url = new URL("/api/model/effective", window.location.origin);
        url.searchParams.set("reportedModel", reportedModel);
        const res = await fetch(url.toString());
        if (res.ok) {
          const data = await res.json();
          setEffectiveModel(data);
        }
      } catch {
        // Ignore errors
      } finally {
        setLoading(false);
      }
    };

    fetchEffectiveModel();
  }, [settings.claude_model]);

  return (
    <div className="space-y-6">
      <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
        Summary AI
      </h2>
      <p className="text-xs text-muted-foreground">
        AI models used for session summary generation. Summaries use direct API calls (no CLI sessions spawned).
        Long transcripts are automatically split into chunks (map/reduce).
      </p>

      {/* Environment override warning */}
      {effectiveModel?.isOverridden && (
        <div className="p-3 rounded-md bg-amber-500/10 border border-amber-500/20">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-amber-700 dark:text-amber-300">
                Model overridden by environment variables
              </div>
              <p className="text-xs text-amber-600/80 dark:text-amber-400/80 mt-1">
                Your shell environment (e.g., <code className="px-1 py-0.5 rounded bg-amber-500/20">~/.zshrc</code>) sets{" "}
                <code className="px-1 py-0.5 rounded bg-amber-500/20">ANTHROPIC_BASE_URL</code> and{" "}
                <code className="px-1 py-0.5 rounded bg-amber-500/20">ANTHROPIC_DEFAULT_*_MODEL</code>.
                The effective model is{" "}
                <span className="font-medium">{effectiveModel.shortLabel}</span>.
              </p>
              <div className="flex items-center gap-2 mt-2">
                <EffectiveModelBadge reportedModel={settings.claude_model || null} variant="compact" />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* CLI Model — what model Claude Code sessions run on */}
      <div className="space-y-1">
        <div className="text-sm font-medium">CLI session model</div>
        <p className="text-xs text-muted-foreground">
          Model used when starting or resuming Claude Code sessions. Z.AI models route through Z.AI and run on GLM.
        </p>
        <ModelSelector
          settingKey="claude_model"
          currentModel={settings.claude_model || "claude-sonnet-4-6"}
          onUpdate={onUpdate}
        />
      </div>

      {/* One-shot summary model */}
      <div className="space-y-1">
        <div className="text-sm font-medium">Summary model</div>
        <p className="text-xs text-muted-foreground">
          Model for generating full session summaries. Any OpenAI, Anthropic, Google, or Z.AI model.
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
          value={settings.learnings_model || "gemini-2.5-flash"}
          onChange={(e) => onUpdate("learnings_model", e.target.value)}
          onBlur={(e) => onUpdate("learnings_model", e.target.value.trim())}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          placeholder="gemini-2.5-flash"
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
          { key: "zai_api_key", label: "Z.AI (GLM)", placeholder: "Z.AI API key" },
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
