"use client";

import { useEffect, useState } from "react";
import { Loader2, AlertCircle, X, Search, ArrowLeft, Package, ChevronDown, ChevronUp } from "lucide-react";
import Link from "next/link";
import {
  SystemHealthSettings,
  MacOSPermissionsSettings,
  MaintenanceSettings,
  TerminalSettings,
  NotificationsSettings,
  SearchSettings,
  AppearanceSettings,
} from "@/components/settings";
import type { HealthCheck } from "@/components/settings";
import { EmbeddedStore } from "@/components/store/EmbeddedStore";
import { PLUGINS } from "@/components/store/plugin-data";

// ── Types ────────────────────────────────────────────────────────────────────

interface Settings {
  auto_kill_terminal_on_reply: string;
  [key: string]: string | undefined;
}

// ── SettingsPage ──────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [healthChecks, setHealthChecks] = useState<HealthCheck[] | null>(null);
  const [settingsSearch, setSettingsSearch] = useState("");
  const [storeExpanded, setStoreExpanded] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => setSettings(data))
      .catch(() => setError("Failed to load settings"))
      .finally(() => setLoading(false));

    fetch("/api/health")
      .then((r) => r.json())
      .then((data) => setHealthChecks(data.checks))
      .catch(() => {});
  }, []);

  async function updateSetting(key: string, value: string): Promise<void> {
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
  }

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

  // ── Settings search ──
  const SECTION_KEYWORDS: Record<string, string> = {
    "system-setup": "system setup health check database jsonl cli",
    "macos-permissions": "macos permissions accessibility terminal focus",
    "terminal-integration": "terminal auto kill retry crash continue stall close new session reply",
    "notifications": "notifications sound browser tab badge notify",
    "deep-search": "deep search vector pre-filter gemini google ai api key",
    "folder-browser": "folder browser start path browse",
    "appearance": "appearance font size scale theme",
    "maintenance": "maintenance title generate regenerate ai titles",
  };

  function sectionVisible(id: string): boolean {
    if (!settingsSearch.trim()) return true;
    const q = settingsSearch.toLowerCase();
    const keywords = SECTION_KEYWORDS[id] || "";
    return keywords.includes(q);
  }

  // Check if search matches any plugin (name, settingsKeys, description)
  const pluginSearchMatch = (() => {
    if (!settingsSearch.trim()) return false;
    const q = settingsSearch.toLowerCase().replace(/[_\s-]+/g, "");
    return PLUGINS.some((p) => {
      const haystack = [
        p.name, p.id, p.description,
        ...(p.settingsKeys || []),
        ...(p.tags || []),
      ].join(" ").toLowerCase().replace(/[_\s-]+/g, "");
      return haystack.includes(q);
    });
  })();

  const visibleCount = Object.keys(SECTION_KEYWORDS).filter(sectionVisible).length;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[600px] mx-auto px-6 py-8 space-y-8">
        <div>
          <Link
            href="/claude-sessions"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-3"
          >
            <ArrowLeft className="h-3 w-3" />
            Back to sessions
          </Link>
          <h1 className="text-lg font-semibold">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">
            System preferences and plugin configuration.
          </p>
          <div className="relative mt-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
            <input
              type="text"
              value={settingsSearch}
              onChange={(e) => setSettingsSearch(e.target.value)}
              placeholder="Search settings…"
              className="w-full pl-9 pr-8 py-2 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {settingsSearch && (
              <button
                onClick={() => setSettingsSearch("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {visibleCount === 0 && !pluginSearchMatch && (
          <div className="text-sm text-muted-foreground text-center py-8">
            No settings match &ldquo;{settingsSearch}&rdquo;
          </div>
        )}

        {/* ── System Setup ── */}
        {sectionVisible("system-setup") && <SystemHealthSettings healthChecks={healthChecks} />}

        {/* ── Maintenance ── */}
        {sectionVisible("maintenance") && <MaintenanceSettings />}

        {/* ── macOS Permissions ── */}
        {sectionVisible("macos-permissions") && <MacOSPermissionsSettings />}

        {/* ── Terminal Integration ── */}
        {sectionVisible("terminal-integration") && (
          <TerminalSettings settings={settings} onUpdate={updateSetting} savedKey={savedKey} />
        )}

        {/* ── Notifications ── */}
        {sectionVisible("notifications") && (
          <NotificationsSettings
            settings={settings}
            onUpdate={updateSetting}
            savedKey={savedKey}
            onError={setError}
          />
        )}

        {/* ── Deep Search + Folder Browser ── */}
        {(sectionVisible("deep-search") || sectionVisible("folder-browser")) && (
          <SearchSettings settings={settings} onUpdate={updateSetting} savedKey={savedKey} />
        )}

        {/* ── Appearance ── */}
        {sectionVisible("appearance") && <AppearanceSettings />}

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

      {/* ── Store peek — always visible at bottom ── */}
      <div className="border-t border-border bg-muted/20">
        <div className="max-w-5xl mx-auto">
          <button
            onClick={() => setStoreExpanded(!storeExpanded)}
            className="w-full px-6 py-4 flex items-center gap-3 hover:bg-muted/30 transition-colors"
          >
            <Package className="h-5 w-5 text-muted-foreground/60" />
            <div className="flex-1 text-left">
              <div className="text-sm font-medium">Plugin settings &amp; Store</div>
              <div className="text-[11px] text-muted-foreground/60">
                Relay, AI models, workers, permissions, and more
              </div>
            </div>
            {(storeExpanded || pluginSearchMatch) ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground/40" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground/40" />
            )}
          </button>

          {/* Peek preview — always visible: first few plugin cards */}
          {!storeExpanded && !pluginSearchMatch && (
            <div className="px-6 pb-4">
              <EmbeddedStore peek externalSettings={settings} />
            </div>
          )}

          {/* Full store — expanded (also auto-expand on plugin search match) */}
          {(storeExpanded || pluginSearchMatch) && (
            <div className="px-6 pb-8">
              <EmbeddedStore
                externalSettings={settings}
                onExternalSettingUpdate={updateSetting}
                externalSavedKey={savedKey}
                searchQuery={settingsSearch}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
