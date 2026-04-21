"use client";

import { useState, useEffect } from "react";
import { Settings2 } from "lucide-react";
import { PluginCard, type PluginData, type PluginStatus } from "./PluginCard";
import { PluginDetail } from "./PluginDetail";
import { PLUGINS } from "./plugin-data";

interface EmbeddedStoreProps {
  peek?: boolean;
  externalSettings?: Record<string, string | undefined>;
  onExternalSettingUpdate?: (key: string, value: string) => void;
  externalSavedKey?: string | null;
  searchQuery?: string;
}

export function EmbeddedStore({ peek, externalSettings, onExternalSettingUpdate, externalSavedKey, searchQuery }: EmbeddedStoreProps) {
  const [plugins, setPlugins] = useState(PLUGINS);
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    // Auto-select from URL: ?plugin=remote-relay or #remote-relay
    if (typeof window !== "undefined") {
      const fromParam = new URLSearchParams(window.location.search).get("plugin");
      if (fromParam) return fromParam;
      const hash = window.location.hash.slice(1);
      if (hash) return hash;
    }
    return null;
  });

  // Auto-select plugin matching search query
  useEffect(() => {
    if (!searchQuery?.trim()) return;
    const q = searchQuery.toLowerCase().replace(/[_\s-]+/g, "");
    const match = PLUGINS.find((p) => {
      const haystack = [
        p.name, p.id, p.description,
        ...(p.settingsKeys || []),
        ...(p.tags || []),
      ].join(" ").toLowerCase().replace(/[_\s-]+/g, "");
      return haystack.includes(q);
    });
    if (match) setSelectedId(match.id);
  }, [searchQuery]);
  // React to ?plugin= param changes (check on mount and popstate)
  useEffect(() => {
    function checkUrlPlugin() {
      const p = new URLSearchParams(window.location.search).get("plugin");
      if (p) setSelectedId(p);
    }
    checkUrlPlugin();
    window.addEventListener("popstate", checkUrlPlugin);
    return () => window.removeEventListener("popstate", checkUrlPlugin);
  }, []);

  const [installing, setInstalling] = useState<string | null>(null);
  const [installLog, setInstallLog] = useState<string | null>(null);
  const [ownSettings, setOwnSettings] = useState<Record<string, string>>({});
  const [ownSavedKey, setOwnSavedKey] = useState<string | null>(null);

  // Use external settings if provided (avoids duplicate fetch)
  const settings = (externalSettings ?? ownSettings) as Record<string, string>;
  const savedKey = externalSavedKey ?? ownSavedKey;

  useEffect(() => {
    // Skip settings fetch if parent provides them
    if (!externalSettings) {
      fetch("/api/settings")
        .then((r) => r.json())
        .then((data: Record<string, string>) => {
          setOwnSettings(data);
          if (data.new_session_from_reply === "true") {
            setPlugins((prev) =>
              prev.map((p) => (p.id === "new-session-from-reply" ? { ...p, status: "installed" as const } : p))
            );
          }
        })
        .catch(() => {});
    } else {
      // Sync plugin statuses from external settings
      if (externalSettings.new_session_from_reply === "true") {
        setPlugins((prev) =>
          prev.map((p) => (p.id === "new-session-from-reply" ? { ...p, status: "installed" as const } : p))
        );
      }
    }

    fetch("/api/permissions/install")
      .then((r) => r.json())
      .then((data) => {
        if (data.installed) {
          setPlugins((prev) =>
            prev.map((p) => (p.id === "permission-bridge" ? { ...p, status: "installed" as const } : p))
          );
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function updateSetting(key: string, value: string) {
    if (onExternalSettingUpdate) {
      onExternalSettingUpdate(key, value);
      return;
    }
    setOwnSavedKey(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      if (!res.ok) return;
      const data = await res.json();
      setOwnSettings(data);
      setOwnSavedKey(key);
      setTimeout(() => setOwnSavedKey(null), 2000);
    } catch { /* ignore */ }
  }

  const toggleInstall = async (id: string) => {
    if (id === "permission-bridge") {
      const plugin = plugins.find((p) => p.id === id);
      if (!plugin) return;
      setInstalling(id);
      setInstallLog(null);
      try {
        if (plugin.status === "installed") {
          const res = await fetch("/api/permissions/install", { method: "DELETE" });
          const data = await res.json();
          setInstallLog(data.log);
          if (data.ok) {
            setPlugins((prev) => prev.map((p) => (p.id === id ? { ...p, status: "available" as const } : p)));
          }
        } else {
          const res = await fetch("/api/permissions/install", { method: "POST" });
          const data = await res.json();
          setInstallLog(data.log);
          if (data.ok) {
            setPlugins((prev) => prev.map((p) => (p.id === id ? { ...p, status: "installed" as const } : p)));
          }
        }
      } catch (e) {
        setInstallLog(`Error: ${e}`);
      } finally {
        setInstalling(null);
      }
      return;
    }

    const settingKey: Record<string, string> = {
      "new-session-from-reply": "new_session_from_reply",
    };
    if (settingKey[id]) {
      const plugin = plugins.find((p) => p.id === id);
      if (!plugin) return;
      const newValue = plugin.status === "installed" ? "false" : "true";
      try {
        await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [settingKey[id]]: newValue }),
        });
        setPlugins((prev) =>
          prev.map((p) =>
            p.id === id
              ? { ...p, status: newValue === "true" ? "installed" as const : "available" as const }
              : p
          )
        );
      } catch { /* ignore */ }
      return;
    }

    setPlugins((prev) =>
      prev.map((p) => {
        if (p.id !== id) return p;
        if (p.status === "in_progress" || p.status === "requested") return p;
        return { ...p, status: p.status === "installed" ? "available" as const : "installed" as const };
      })
    );
  };

  const groups = ([
    { status: "installed" as const, label: "Installed" },
    { status: "available" as const, label: "Available" },
    { status: "in_progress" as const, label: "In progress" },
    { status: "requested" as const, label: "Requested" },
  ]).map((g) => ({ ...g, items: plugins.filter((p) => p.status === g.status) }))
    .filter((g) => g.items.length > 0);

  const selectedPlugin = plugins.find((p) => p.id === selectedId) || null;

  // Peek mode: show installed plugins with settings as compact row
  if (peek) {
    const withSettings = plugins.filter((p) => p.settingsComponent && p.status === "installed");
    return (
      <div className="flex flex-wrap gap-2">
        {withSettings.slice(0, 6).map((plugin) => (
          <PluginCard
            key={plugin.id}
            plugin={plugin}
            selected={false}
            onClick={() => {}}
          />
        ))}
        <div className="w-full text-[11px] text-muted-foreground/40 mt-1">
          {plugins.length} plugins total — expand to browse &amp; configure
        </div>
      </div>
    );
  }

  // Full mode: two-column layout
  return (
    <div className="grid grid-cols-[minmax(260px,2fr)_3fr] gap-6">
      <div className="space-y-4">
        {groups.map((group) => (
          <div key={group.status}>
            <div className="flex items-center gap-2 mb-1 px-1">
              <span className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wide">
                {group.label}
              </span>
              <span className="text-[10px] text-muted-foreground/30">{group.items.length}</span>
              <div className="flex-1 h-px bg-border/20" />
            </div>
            <div className="space-y-0.5">
              {group.items.map((plugin) => (
                <PluginCard
                  key={plugin.id}
                  plugin={plugin}
                  selected={selectedId === plugin.id}
                  onClick={() => setSelectedId(plugin.id)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="min-h-[400px]">
        {selectedPlugin ? (
          <div className="sticky top-6 border border-border rounded-lg p-5 bg-card">
            <PluginDetail
              plugin={selectedPlugin}
              installing={installing === selectedPlugin.id}
              installLog={installLog}
              onToggleInstall={toggleInstall}
              settings={settings}
              onUpdateSetting={updateSetting}
              savedKey={savedKey}
            />
          </div>
        ) : (
          <div className="sticky top-6 border border-dashed border-border/50 rounded-lg p-8 flex flex-col items-center justify-center text-center min-h-[300px]">
            <Settings2 className="h-8 w-8 text-muted-foreground/20 mb-3" />
            <p className="text-sm text-muted-foreground/50">
              Select a plugin to view details and configuration
            </p>
            <p className="text-[11px] text-muted-foreground/30 mt-1">
              Plugins with ⚙ have configurable settings
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
