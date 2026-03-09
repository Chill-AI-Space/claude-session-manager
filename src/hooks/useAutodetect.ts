"use client";

import { useState, useRef, useCallback } from "react";

export interface AutodetectSuggestion {
  project_dir: string;
  project_path: string;
  display_name: string;
}

export function useAutodetect() {
  const [detecting, setDetecting] = useState(false);
  const [suggestions, setSuggestions] = useState<AutodetectSuggestion[]>([]);
  const [autodetected, setAutodetected] = useState(false);
  const [geminiConfigured, setGeminiConfigured] = useState<boolean | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const detect = useCallback(async (prompt: string): Promise<string | null> => {
    const msg = prompt.trim();
    if (!msg || detecting) return null;
    setDetecting(true);

    abortRef.current?.abort("cancelled");
    const abort = new AbortController();
    abortRef.current = abort;

    let firstPath: string | null = null;

    try {
      // Phase 1: fast keyword match
      const fastRes = await fetch("/api/projects/autodetect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: msg, mode: "fast" }),
        signal: abort.signal,
      });
      const fastData = await fastRes.json();
      if (abort.signal.aborted) return null;

      if (fastData.gemini_configured !== undefined) {
        setGeminiConfigured(fastData.gemini_configured);
      }
      if (fastData.matches?.length > 0) {
        setSuggestions(fastData.matches);
        setAutodetected(true);
        firstPath = fastData.matches[0].project_path;
      }

      // Phase 2: Gemini upgrade (background)
      fetch("/api/projects/autodetect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: msg, mode: "smart" }),
        signal: abort.signal,
      })
        .then(r => r.json())
        .then(smartData => {
          if (abort.signal.aborted) return;
          if (smartData.matches?.length > 0 && smartData.method === "gemini") {
            setSuggestions(smartData.matches);
          }
        })
        .catch(() => {});
    } catch {
      // ignore aborts
    } finally {
      if (!abort.signal.aborted) setDetecting(false);
    }

    return firstPath;
  }, [detecting]);

  const clearSuggestions = useCallback(() => {
    setSuggestions([]);
    setAutodetected(false);
  }, []);

  return { detecting, suggestions, autodetected, geminiConfigured, detect, clearSuggestions, setAutodetected };
}
