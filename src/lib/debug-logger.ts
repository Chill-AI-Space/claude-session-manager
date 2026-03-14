/**
 * Structured debug logger with ring buffer, SSE streaming, and remote push.
 *
 * - Captures all server-side events (scan, crash, retry, spawn, errors)
 * - Ring buffer keeps last N entries in memory
 * - SSE subscribers get real-time stream + buffer replay on connect
 * - Remote push: batches entries and POSTs to `debug_log_endpoint` every 10s
 * - Controlled by `debug_mode` setting
 */

import os from "os";
import { getSetting } from "./db";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: string;       // ISO timestamp
  level: LogLevel;
  source: string;   // e.g. "scanner", "claude-runner", "process-detector"
  message: string;
  data?: Record<string, unknown>;
}

// ── Instance identity (sent with remote logs) ────────────────────────────────

const instanceId = `${os.hostname()}-${process.platform}-${process.pid}`;

// ── Ring Buffer ──────────────────────────────────────────────────────────────

const MAX_ENTRIES = 500;
const buffer: LogEntry[] = [];
let bufferIndex = 0;
let totalEntries = 0;

function pushEntry(entry: LogEntry): void {
  if (buffer.length < MAX_ENTRIES) {
    buffer.push(entry);
  } else {
    buffer[bufferIndex] = entry;
  }
  bufferIndex = (bufferIndex + 1) % MAX_ENTRIES;
  totalEntries++;

  // Notify all SSE subscribers
  for (const sub of subscribers) {
    try {
      sub(entry);
    } catch {
      // subscriber dead, will be cleaned up
    }
  }

  // Queue for remote push
  remoteBatch.push(entry);
}

/** Get all buffered entries in chronological order */
export function getBufferedEntries(): LogEntry[] {
  if (buffer.length < MAX_ENTRIES) {
    return [...buffer];
  }
  // Ring buffer: entries from bufferIndex..end + 0..bufferIndex
  return [...buffer.slice(bufferIndex), ...buffer.slice(0, bufferIndex)];
}

// ── SSE Subscribers ──────────────────────────────────────────────────────────

type Subscriber = (entry: LogEntry) => void;
const subscribers = new Set<Subscriber>();

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function subscriberCount(): number {
  return subscribers.size;
}

// ── Remote Push ──────────────────────────────────────────────────────────────

const FLUSH_INTERVAL_MS = 10_000;
const MAX_BATCH_SIZE = 100;
let remoteBatch: LogEntry[] = [];
let flushTimer: NodeJS.Timeout | null = null;

function startRemoteFlush(): void {
  if (flushTimer) return;
  flushTimer = setInterval(flushRemote, FLUSH_INTERVAL_MS);
  // Don't keep the process alive just for log flushing
  if (flushTimer.unref) flushTimer.unref();
}

async function flushRemote(): Promise<void> {
  if (remoteBatch.length === 0) return;

  const endpoint = getSetting("debug_log_endpoint");
  if (!endpoint) return;

  // Grab current batch and reset
  const batch = remoteBatch.slice(0, MAX_BATCH_SIZE);
  remoteBatch = remoteBatch.slice(MAX_BATCH_SIZE);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instance: instanceId,
        entries: batch,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      // Put entries back for retry (but cap to prevent unbounded growth)
      if (remoteBatch.length < MAX_ENTRIES) {
        remoteBatch = [...batch, ...remoteBatch];
      }
    }
  } catch {
    // Network error — put entries back (capped)
    if (remoteBatch.length < MAX_ENTRIES) {
      remoteBatch = [...batch, ...remoteBatch];
    }
  }
}

// Start flush timer on module load
startRemoteFlush();

// ── Logging API ──────────────────────────────────────────────────────────────

export function isDebugEnabled(): boolean {
  return getSetting("debug_mode") === "true";
}

function log(level: LogLevel, source: string, message: string, data?: Record<string, unknown>): void {
  // Always buffer if debug mode is on, or if level is error/warn
  if (!isDebugEnabled() && level !== "error" && level !== "warn") return;

  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    source,
    message,
    ...(data && { data }),
  };

  pushEntry(entry);
}

export function debug(source: string, message: string, data?: Record<string, unknown>): void {
  log("debug", source, message, data);
}

export function info(source: string, message: string, data?: Record<string, unknown>): void {
  log("info", source, message, data);
}

export function warn(source: string, message: string, data?: Record<string, unknown>): void {
  log("warn", source, message, data);
}

export function error(source: string, message: string, data?: Record<string, unknown>): void {
  log("error", source, message, data);
}

// ── Convenience: wrap a catch block ──────────────────────────────────────────

export function logCatch(source: string, context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  log("error", source, `${context}: ${message}`, {
    stack: err instanceof Error ? err.stack : undefined,
  });
}
