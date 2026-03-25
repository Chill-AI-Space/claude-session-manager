"use client";

import { Check, ExternalLink } from "lucide-react";
import { SettingsComponentProps } from "./types";

export function NewSessionFromReplySettings({ settings, onUpdate, savedKey }: SettingsComponentProps) {
  const hasKey = !!settings.google_ai_api_key;

  return (
    <div className="space-y-5">
      <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
        Context Carry-Over
      </h2>
      <p className="text-xs text-muted-foreground leading-relaxed">
        When starting a new session from an existing one, the previous session&apos;s context
        can be extracted and passed along. Without an API key, context is truncated mechanically
        (first + last messages). With Gemini, only the relevant parts are extracted by AI.
      </p>

      {/* Google AI key status + input */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <div className={`h-2 w-2 rounded-full ${hasKey ? "bg-green-500" : "bg-zinc-400"}`} />
          <span className="text-sm font-medium">Google AI (Gemini) key</span>
          {hasKey && (
            <span className="text-[10px] text-green-600 dark:text-green-400">
              configured &mdash; AI context extraction active
            </span>
          )}
          {!hasKey && (
            <span className="text-[10px] text-muted-foreground/60">
              not configured &mdash; using truncated fallback
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Free at{" "}
          <a
            href="https://aistudio.google.com/apikey"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-foreground"
          >
            aistudio.google.com/apikey
            <ExternalLink className="h-2.5 w-2.5" />
          </a>
          . Same key used by Summary AI and Deep Search.
        </p>
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={settings.google_ai_api_key || ""}
            onChange={(e) => onUpdate("google_ai_api_key", e.target.value)}
            onBlur={(e) => onUpdate("google_ai_api_key", e.target.value.trim())}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            placeholder="AIza..."
            className="flex-1 px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {savedKey === "google_ai_api_key" && (
            <span className="flex items-center gap-1 text-xs text-green-500 animate-in fade-in duration-200">
              <Check className="h-3 w-3" />
              Saved
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
