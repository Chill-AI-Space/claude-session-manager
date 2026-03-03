"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

interface Settings {
  auto_kill_terminal_on_reply: string;
  [key: string]: string;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        setSettings(data);
        setLoading(false);
      });
  }, []);

  const updateSetting = async (key: string, value: string) => {
    setSaving(true);
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: value }),
    });
    const data = await res.json();
    setSettings(data);
    setSaving(false);
  };

  if (loading || !settings) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[600px] mx-auto px-6 py-8 space-y-8">
        <div>
          <h1 className="text-lg font-semibold">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configure how Session Manager behaves when interacting with sessions.
          </p>
        </div>

        <div className="space-y-6">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Terminal Integration
          </h2>

          <label className="flex items-start gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={settings.auto_kill_terminal_on_reply === "true"}
              onChange={(e) =>
                updateSetting(
                  "auto_kill_terminal_on_reply",
                  e.target.checked ? "true" : "false"
                )
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
        </div>

        <div className="space-y-6">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Permissions
          </h2>

          <label className="flex items-start gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={settings.dangerously_skip_permissions === "true"}
              onChange={(e) =>
                updateSetting(
                  "dangerously_skip_permissions",
                  e.target.checked ? "true" : "false"
                )
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
        </div>

        {saving && (
          <div className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" />
            Saving...
          </div>
        )}
      </div>
    </div>
  );
}
