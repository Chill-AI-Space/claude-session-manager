"use client";

import { useEffect, useRef, useCallback } from "react";

interface CapturedError {
  timestamp: string;
  type: "error" | "unhandledrejection" | "fetch_error" | "render_error";
  message: string;
  stack?: string;
  url?: string;
  source?: string;
}

const MAX_ERRORS = 100;
const capturedErrors: CapturedError[] = [];

function pushError(err: CapturedError) {
  capturedErrors.push(err);
  if (capturedErrors.length > MAX_ERRORS) capturedErrors.shift();
}

// Install global error handlers (runs once)
let installed = false;
function installGlobalHandlers() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (e) => {
    // Skip abort-related errors
    if (e.message?.includes("AbortError") || e.message === "cancelled") return;
    pushError({
      timestamp: new Date().toISOString(),
      type: "error",
      message: e.message || String(e),
      stack: e.error?.stack,
      source: `${e.filename}:${e.lineno}:${e.colno}`,
    });
  });

  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    if (reason === "cancelled" || (reason instanceof DOMException && reason.name === "AbortError")) return;
    pushError({
      timestamp: new Date().toISOString(),
      type: "unhandledrejection",
      message: String(reason?.message || reason),
      stack: reason?.stack,
    });
  });

  // Monkey-patch fetch to capture network errors
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    try {
      const response = await originalFetch.apply(this, args);
      if (!response.ok && response.status >= 500) {
        pushError({
          timestamp: new Date().toISOString(),
          type: "fetch_error",
          message: `HTTP ${response.status} ${response.statusText}`,
          url: typeof args[0] === "string" ? args[0] : args[0]?.toString(),
        });
      }
      return response;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      pushError({
        timestamp: new Date().toISOString(),
        type: "fetch_error",
        message: String(err),
        url: typeof args[0] === "string" ? args[0] : args[0]?.toString(),
      });
      throw err;
    }
  };
}

export function useDebugCapture() {
  const startTime = useRef(Date.now());

  useEffect(() => {
    installGlobalHandlers();
  }, []);

  const generateReport = useCallback(async (): Promise<Record<string, unknown>> => {
    // Gather client-side info
    const clientPayload = {
      client_errors: [...capturedErrors],
      user_agent: navigator.userAgent,
      screen: {
        width: screen.width,
        height: screen.height,
        devicePixelRatio: window.devicePixelRatio,
      },
      url: window.location.href,
      performance: {
        session_duration_min: +((Date.now() - startTime.current) / 60000).toFixed(1),
        memory: (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory
          ? {
              used_mb: Math.round(
                (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize / 1024 / 1024
              ),
              total_mb: Math.round(
                (performance as unknown as { memory: { totalJSHeapSize: number } }).memory.totalJSHeapSize / 1024 / 1024
              ),
            }
          : null,
      },
    };

    // Send to server to combine with server-side diagnostics
    const res = await fetch("/api/debug-report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(clientPayload),
    });
    return await res.json();
  }, []);

  const downloadReport = useCallback(async () => {
    const report = await generateReport();
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `debug-report-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [generateReport]);

  return {
    capturedErrors,
    errorCount: capturedErrors.length,
    generateReport,
    downloadReport,
  };
}
