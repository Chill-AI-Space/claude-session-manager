"use client";

import { useState, useCallback, useEffect } from "react";

export function useSettingToggle(key: string, defaultValue = false) {
  const [value, setValue] = useState(defaultValue);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then(r => r.json())
      .then(data => {
        setValue(data[key] === "true");
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [key]);

  const toggle = useCallback(async () => {
    const next = !value;
    setValue(next); // optimistic
    try {
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: next ? "true" : "false" }),
      });
    } catch {
      setValue(!next); // revert
    }
  }, [key, value]);

  return { value, toggle, loaded };
}
