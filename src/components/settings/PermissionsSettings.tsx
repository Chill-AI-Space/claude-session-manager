"use client";

import { SettingsComponentProps } from "./types";

export function PermissionsSettings({ settings, onUpdate }: SettingsComponentProps) {
  return (
    <div className="space-y-6">
      <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
        Permissions
      </h2>

      <label className="flex items-start gap-3 cursor-pointer group">
        <input
          type="checkbox"
          checked={settings.dangerously_skip_permissions === "true"}
          onChange={(e) =>
            onUpdate("dangerously_skip_permissions", e.target.checked ? "true" : "false")
          }
          className="mt-1 h-4 w-4 rounded border-input accent-primary"
        />
        <div className="space-y-1">
          <div className="text-sm font-medium">
            Dangerously skip permissions
          </div>
          <div className="text-xs text-muted-foreground leading-relaxed">
            Pass <code className="px-1 py-0.5 bg-muted rounded text-[11px]">--dangerously-skip-permissions</code> when
            resuming sessions from the web interface and when opening in terminal.
            Claude will execute all tool calls without asking for confirmation.
            Use this only if you understand the risks.
          </div>
        </div>
      </label>
      <div className="space-y-2">
        <div className="text-sm font-medium">Max turns per reply</div>
        <div className="text-xs text-muted-foreground leading-relaxed mb-2">
          How many tool-use cycles Claude is allowed per single web reply.
          Each &quot;turn&quot; is one round of Claude calling a tool (Read, Bash, Edit, etc.) and getting the result back.
          <br /><br />
          <strong>Why this matters:</strong> Web replies use <code className="font-mono bg-muted px-1 rounded">claude -p</code> (non-interactive mode),
          which runs Claude as a one-shot process. Without enough turns, Claude may stop mid-task —
          e.g. say &quot;I{"'"}ll write the file now&quot; but exit before actually writing it.
          In the terminal, Claude runs interactively with unlimited turns.
          This setting bridges that gap.
          <br /><br />
          Set higher (100–200) for complex tasks. Set lower (10–20) for quick replies.
          Default: 80.
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={200}
            value={settings.max_turns || "80"}
            onChange={(e) => onUpdate("max_turns", e.target.value)}
            className="w-24 px-2 py-1.5 text-sm border border-input rounded-md bg-background"
          />
        </div>
      </div>
      <div className="space-y-2">
        <div className="text-sm font-medium">Effort level</div>
        <div className="text-xs text-muted-foreground leading-relaxed mb-2">
          Controls how much thinking Claude puts into responses.
          <strong> High</strong> = maximum effort (deeper reasoning, better results).
          <strong> Medium</strong> = faster but less thorough.
          <strong> Low</strong> = quickest, minimal thinking.
          <br /><br />
          Default: High.
        </div>
        <div className="flex items-center gap-2">
          <select
            value={settings.effort_level || "high"}
            onChange={(e) => onUpdate("effort_level", e.target.value)}
            className="px-3 py-1.5 text-sm border border-input rounded-md bg-background"
          >
            <option value="high">High (maximum)</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
      </div>
    </div>
  );
}
