"use client";

import { useState, useEffect, useCallback } from "react";

export function useSettings() {
  const [settings, setSettings] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => setSettings(data))
      .catch(() => {});
  }, []);

  const updateSetting = useCallback(async (key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value })); // optimistic
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      if (res.ok) {
        const updated = await res.json();
        setSettings(updated);
      }
    } catch {
      // keep optimistic value on network error
    }
  }, []);

  return { settings, updateSetting };
}
