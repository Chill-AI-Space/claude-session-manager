"use client";

import { useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";

interface UseSessionStartOptions {
  /** Called before sending — return the final message (e.g., with context prepended) */
  prepareMessage?: (msg: string) => Promise<string>;
}

export function useSessionStart(opts?: UseSessionStartOptions) {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [startTimeout, setStartTimeout] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const start = useCallback(async (path: string, message: string) => {
    const msg = message.trim();
    if (!msg || !path || starting) return;
    setStarting(true);
    setError(null);
    setStartTimeout(false);

    timerRef.current = setTimeout(() => setStartTimeout(true), 30_000);

    try {
      const finalMessage = opts?.prepareMessage ? await opts.prepareMessage(msg) : msg;

      const res = await fetch("/api/sessions/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, message: finalMessage }),
      });

      if (!res.ok) throw new Error("Failed to start session");

      if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let navigated = false;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            for (const line of text.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              try {
                const obj = JSON.parse(line.slice(6));
                if (obj.type === "session_id" && obj.session_id && !navigated) {
                  navigated = true;
                  if (timerRef.current) clearTimeout(timerRef.current);
                  router.push(`/claude-sessions/${obj.session_id}`);
                }
                if (obj.type === "error") {
                  setError(obj.text);
                  if (timerRef.current) clearTimeout(timerRef.current);
                  setStarting(false);
                }
              } catch { /* skip non-JSON */ }
            }
          }
        } catch { /* stream closed */ }

        if (!navigated) {
          if (timerRef.current) clearTimeout(timerRef.current);
          setError("Session started but no ID received. Check the sidebar.");
          setStarting(false);
        }
      }
    } catch (e) {
      if (timerRef.current) clearTimeout(timerRef.current);
      setError(e instanceof Error ? e.message : "Failed to start session");
      setStarting(false);
    }
  }, [starting, opts, router]);

  const cancel = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setStarting(false);
    setStartTimeout(false);
  }, []);

  return { starting, startTimeout, error, start, cancel, setError };
}
