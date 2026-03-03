"use client";

import { useEffect, useState } from "react";
import { Loader2, Check, AlertCircle } from "lucide-react";

interface Settings {
  auto_kill_terminal_on_reply: string;
  [key: string]: string;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        setSettings(data);
      })
      .catch(() => {
        setError("Failed to load settings");
      })
      .finally(() => setLoading(false));
  }, []);

  const updateSetting = async (key: string, value: string) => {
    setSaving(true);
    setSavedKey(null);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      if (!res.ok) throw new Error("Save failed");
      const data = await res.json();
      setSettings(data);
      setSavedKey(key);
      setTimeout(() => setSavedKey(null), 2000);
    } catch {
      setError("Failed to save setting");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error && !settings) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-destructive gap-2">
        <AlertCircle className="h-4 w-4" />
        {error}
      </div>
    );
  }

  if (!settings) return null;

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

        <div className="space-y-6">
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
                onChange={(e) =>
                  setSettings({ ...settings, vector_search_top_k: e.target.value })
                }
                onBlur={(e) => {
                  const val = Math.max(5, Math.min(100, parseInt(e.target.value) || 20));
                  updateSetting("vector_search_top_k", val.toString());
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    (e.target as HTMLInputElement).blur();
                  }
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

        <div className="space-y-6">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Folder Browser
          </h2>

          <div className="space-y-2">
            <div className="text-sm font-medium">Start browsing from</div>
            <div className="text-xs text-muted-foreground leading-relaxed mb-2">
              The folder tree in &quot;Start session&quot; will open at this path
              instead of the home directory. Use a path like{" "}
              <code className="px-1 py-0.5 bg-muted rounded text-[11px]">
                ~/Documents/GitHub
              </code>{" "}
              to jump straight to your projects.
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={settings.browse_start_path || ""}
                onChange={(e) =>
                  setSettings({ ...settings, browse_start_path: e.target.value })
                }
                onBlur={(e) => {
                  const val = e.target.value.trim();
                  updateSetting("browse_start_path", val);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    (e.target as HTMLInputElement).blur();
                  }
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

        {saving && (
          <div className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" />
            Saving...
          </div>
        )}
        {error && settings && (
          <div className="text-xs text-destructive flex items-center gap-1.5">
            <AlertCircle className="h-3 w-3" />
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
