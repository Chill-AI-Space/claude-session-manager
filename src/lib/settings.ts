"use client";

import { useState, useEffect, useCallback } from "react";

// Module-level cache so multiple useSettings() calls share one fetch
let cachedSettings: Record<string, string> | null = null;
let settingsListeners: Array<(s: Record<string, string>) => void> = [];
let fetchPending = false;

function ensureSettingsFetched() {
  if (cachedSettings || fetchPending) return;
  fetchPending = true;
  fetch("/api/settings")
    .then((r) => r.json())
    .then((data) => {
      cachedSettings = data;
      fetchPending = false;
      settingsListeners.forEach((cb) => cb(data));
    })
    .catch(() => { fetchPending = false; });
}

export function useSettings() {
  const [settings, setSettings] = useState<Record<string, string>>(cachedSettings ?? {});

  useEffect(() => {
    if (cachedSettings) {
      setSettings(cachedSettings);
      return;
    }
    settingsListeners.push(setSettings);
    ensureSettingsFetched();
    return () => {
      settingsListeners = settingsListeners.filter((cb) => cb !== setSettings);
    };
  }, []);

  const updateSetting = useCallback(async (key: string, value: string) => {
    const optimistic = { ...(cachedSettings ?? settings), [key]: value };
    cachedSettings = optimistic;
    setSettings(optimistic);
    settingsListeners.forEach((cb) => cb(optimistic));
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      if (res.ok) {
        const updated = await res.json();
        cachedSettings = updated;
        setSettings(updated);
        settingsListeners.forEach((cb) => cb(updated));
      }
    } catch {
      // keep optimistic value on network error
    }
  }, [settings]);

  return { settings, updateSetting };
}
