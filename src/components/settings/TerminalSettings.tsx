"use client";

import Link from "next/link";
import { SettingsComponentProps } from "./types";

export function TerminalSettings({ settings, onUpdate }: SettingsComponentProps) {
  return (
    <div className="space-y-6">
      <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
        Terminal Integration
      </h2>

      <label className="flex items-start gap-3 cursor-pointer group">
        <input
          type="checkbox"
          checked={settings.auto_kill_terminal_on_reply === "true"}
          onChange={(e) =>
            onUpdate("auto_kill_terminal_on_reply", e.target.checked ? "true" : "false")
          }
          className="mt-1 h-4 w-4 rounded border-input accent-primary"
        />
        <div className="space-y-1">
          <div className="text-sm font-medium">
            Automatically close terminal sessions when replying from web
          </div>
          <div className="text-xs text-muted-foreground leading-relaxed">
            When you send a reply from this web interface, any running Claude
            terminal process for that session will be terminated first. This
            prevents conversation divergence between the terminal and web UI.
            If disabled, you can manually close terminal sessions using the
            button that appears after replying.
          </div>
        </div>
      </label>

      <label className="flex items-start gap-3 cursor-pointer group">
        <input
          type="checkbox"
          checked={settings.auto_retry_on_crash !== "false"}
          onChange={(e) =>
            onUpdate("auto_retry_on_crash", e.target.checked ? "true" : "false")
          }
          className="mt-1 h-4 w-4 rounded border-input accent-primary"
        />
        <div className="space-y-1">
          <div className="text-sm font-medium">
            Auto-retry when Claude crashes mid-execution
          </div>
          <div className="text-xs text-muted-foreground leading-relaxed">
            When Claude dies during a tool call (e.g. Bun segfault), automatically
            resend <code className="font-mono bg-muted px-1 rounded">continue</code> after
            a 30-second countdown. You can cancel it.
          </div>
        </div>
      </label>

      <label className="flex items-start gap-3 cursor-pointer group">
        <input
          type="checkbox"
          checked={settings.auto_continue_on_stall === "true"}
          onChange={(e) =>
            onUpdate("auto_continue_on_stall", e.target.checked ? "true" : "false")
          }
          className="mt-1 h-4 w-4 rounded border-input accent-primary"
        />
        <div className="space-y-1">
          <div className="text-sm font-medium">
            Auto-continue when Claude stops mid-task
          </div>
          <div className="text-xs text-muted-foreground leading-relaxed">
            When Claude is active but hasn{"'"}t responded for 5+ minutes and its last message
            doesn{"'"}t ask you a question, automatically send{" "}
            <code className="font-mono bg-muted px-1 rounded">continue</code>.
            Uses AI to detect whether Claude is waiting for your input before firing.
            Logged in the Actions Log as <em>Stall detected</em>.
          </div>
        </div>
      </label>

      <label className="flex items-start gap-3 cursor-pointer group">
        <input
          type="checkbox"
          checked={settings.new_session_from_reply === "true"}
          onChange={(e) =>
            onUpdate("new_session_from_reply", e.target.checked ? "true" : "false")
          }
          className="mt-1 h-4 w-4 rounded border-input accent-primary"
        />
        <div className="space-y-1">
          <div className="text-sm font-medium">
            New session from reply panel
          </div>
          <div className="text-xs text-muted-foreground leading-relaxed">
            Show a toggle in the reply area to start a new session instead of replying.
            Choose a folder, optionally include the current session summary as context,
            and launch — all without leaving the page. Also available in{" "}
            <Link href="/claude-sessions/store" className="underline underline-offset-2 hover:text-foreground">Store</Link>.
          </div>
        </div>
      </label>
    </div>
  );
}
