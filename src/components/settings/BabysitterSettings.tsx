"use client";

import { SettingsComponentProps } from "./types";

export function BabysitterSettings({ settings, onUpdate }: SettingsComponentProps) {
  return (
    <div className="space-y-6">
      <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
        Session Babysitter
      </h2>
      <p className="text-xs text-muted-foreground">
        Monitors sessions for crashes, stalls, and incomplete exits. Automatically resumes
        interrupted work so sessions don&apos;t get stuck.
      </p>

      {/* Crash auto-retry */}
      <div className="space-y-1">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.auto_retry_on_crash !== "false"}
            onChange={() => {
              const val = settings.auto_retry_on_crash === "false" ? "true" : "false";
              onUpdate("auto_retry_on_crash", val);
            }}
            className="rounded border-input accent-primary"
          />
          <span className="text-sm font-medium">Auto-retry on crash</span>
        </label>
        <p className="text-xs text-muted-foreground ml-5">
          When Claude dies mid-tool-execution (<code>tool_result</code> as last message), auto-resume after a delay.
        </p>
      </div>

      {/* Stall auto-continue */}
      <div className="space-y-1">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.auto_continue_on_stall === "true"}
            onChange={() => {
              const val = settings.auto_continue_on_stall === "true" ? "false" : "true";
              onUpdate("auto_continue_on_stall", val);
            }}
            className="rounded border-input accent-primary"
          />
          <span className="text-sm font-medium">Auto-continue on stall</span>
        </label>
        <p className="text-xs text-muted-foreground ml-5">
          When a running Claude process stops writing for &gt;5 minutes (but is still alive), send a nudge to continue.
          Checks with Haiku first to avoid interrupting genuine user-facing questions.
        </p>
      </div>

      {/* Crash retry delay */}
      {settings.auto_retry_on_crash !== "false" && (
        <div className="space-y-1">
          <div className="text-sm font-medium">Crash retry delay</div>
          <p className="text-xs text-muted-foreground">
            How long to wait before auto-retrying a crashed session (ms).
          </p>
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={settings.orchestrator_crash_retry_delay_ms || "30000"}
              onChange={(e) => onUpdate("orchestrator_crash_retry_delay_ms", e.target.value)}
              onBlur={(e) => onUpdate("orchestrator_crash_retry_delay_ms", e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              className="w-32 px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <span className="text-xs text-muted-foreground">
              ({Math.round(parseInt(settings.orchestrator_crash_retry_delay_ms || "30000") / 1000)}s)
            </span>
          </div>
        </div>
      )}

      {/* Stall continue delay */}
      {settings.auto_continue_on_stall === "true" && (
        <div className="space-y-1">
          <div className="text-sm font-medium">Stall continue delay</div>
          <p className="text-xs text-muted-foreground">
            Delay after stall detection before sending the continue nudge (ms).
          </p>
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={settings.orchestrator_stall_continue_delay_ms || "10000"}
              onChange={(e) => onUpdate("orchestrator_stall_continue_delay_ms", e.target.value)}
              onBlur={(e) => onUpdate("orchestrator_stall_continue_delay_ms", e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              className="w-32 px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <span className="text-xs text-muted-foreground">
              ({Math.round(parseInt(settings.orchestrator_stall_continue_delay_ms || "10000") / 1000)}s)
            </span>
          </div>
        </div>
      )}

      {/* Max retries */}
      <div className="space-y-1">
        <div className="text-sm font-medium">Max retries per session</div>
        <p className="text-xs text-muted-foreground">
          After this many failed auto-retries, stop trying and mark the session as failed.
        </p>
        <input
          type="number"
          value={settings.orchestrator_max_retries || "3"}
          onChange={(e) => onUpdate("orchestrator_max_retries", e.target.value)}
          onBlur={(e) => onUpdate("orchestrator_max_retries", e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          min={1}
          max={10}
          className="w-20 px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {/* Max concurrent */}
      <div className="space-y-1">
        <div className="text-sm font-medium">Max concurrent sessions</div>
        <p className="text-xs text-muted-foreground">
          Maximum number of Claude processes the orchestrator will run simultaneously.
        </p>
        <input
          type="number"
          value={settings.orchestrator_max_concurrent || "3"}
          onChange={(e) => onUpdate("orchestrator_max_concurrent", e.target.value)}
          onBlur={(e) => onUpdate("orchestrator_max_concurrent", e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          min={1}
          max={10}
          className="w-20 px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {/* Detection summary */}
      <div className="rounded-md border border-border p-3 space-y-2">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Detection modes</div>
        <div className="space-y-1.5 text-xs">
          <div className="flex items-start gap-2">
            <span className="w-2 h-2 rounded-full bg-orange-500 shrink-0 mt-1" />
            <div>
              <span className="font-medium">Crash</span>
              <span className="text-muted-foreground"> — last message is <code>tool_result</code> (Claude died mid-tool). Auto-resume with context.</span>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0 mt-1" />
            <div>
              <span className="font-medium">Incomplete exit</span>
              <span className="text-muted-foreground"> — last message is <code>assistant</code> with no <code>result</code> event. Claude said &quot;I&apos;ll do X&quot; then died.</span>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <span className="w-2 h-2 rounded-full bg-yellow-500 shrink-0 mt-1" />
            <div>
              <span className="font-medium">Stall</span>
              <span className="text-muted-foreground"> — process alive but no output for &gt;5 min. Checks if Claude is asking a question before nudging.</span>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <span className="w-2 h-2 rounded-full bg-red-500 shrink-0 mt-1" />
            <div>
              <span className="font-medium">Permission loop</span>
              <span className="text-muted-foreground"> — repeated permission errors detected. Escalates to terminal with <code>--dangerously-skip-permissions</code>.</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
