"use client";

import { useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";

interface UseSessionStartOptions {
  /** Called before sending — return the final message (e.g., with context prepended) */
  prepareMessage?: (msg: string) => Promise<string>;
}

/** Fire-and-forget client tracking event */
function trackEvent(event: string, correlationId: string, sessionId?: string, meta?: Record<string, unknown>) {
  fetch("/api/sessions/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, correlationId, sessionId, meta }),
  }).catch(() => {});
}

export function useSessionStart(opts?: UseSessionStartOptions) {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [startTimeout, setStartTimeout] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const start = useCallback(async (path: string, message: string, options?: { agent?: string }) => {
    const msg = message.trim();
    if (!msg || !path || starting) return;
    setStarting(true);
    setError(null);
    setStartTimeout(false);

    // Generate correlation ID for end-to-end tracking
    const correlationId = `start_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();

    trackEvent("session_start_clicked", correlationId, undefined, { path, messageLen: msg.length });

    timerRef.current = setTimeout(() => setStartTimeout(true), 30_000);

    try {
      const finalMessage = opts?.prepareMessage ? await opts.prepareMessage(msg) : msg;

      const res = await fetch("/api/sessions/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, message: finalMessage, correlationId, agent: options?.agent }),
      });

      if (!res.ok) {
        trackEvent("session_start_http_error", correlationId, undefined, { status: res.status, elapsedMs: Date.now() - startedAt });
        throw new Error("Failed to start session");
      }

      trackEvent("session_start_sse_connected", correlationId, undefined, { elapsedMs: Date.now() - startedAt });

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
                  trackEvent("session_start_id_received", correlationId, obj.session_id, { elapsedMs: Date.now() - startedAt });
                  // Dispatch event so sidebar can pick up the new session immediately
                  window.dispatchEvent(new CustomEvent("session-started", { detail: { sessionId: obj.session_id, correlationId } }));
                  router.push(`/claude-sessions/${obj.session_id}`);
                }
                if (obj.type === "error") {
                  trackEvent("session_start_sse_error", correlationId, undefined, { error: obj.text, elapsedMs: Date.now() - startedAt });
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
          trackEvent("session_start_no_id", correlationId, undefined, { elapsedMs: Date.now() - startedAt });
          setError("Session started but no ID received. Check the sidebar.");
          setStarting(false);
        }
      }
    } catch (e) {
      if (timerRef.current) clearTimeout(timerRef.current);
      trackEvent("session_start_exception", correlationId, undefined, { error: e instanceof Error ? e.message : String(e), elapsedMs: Date.now() - startedAt });
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
