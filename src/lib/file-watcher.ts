import fs from "fs";
import path from "path";
import { claudeProjectsDir, UUID_RE } from "./utils";

const CLAUDE_DIR = claudeProjectsDir();

type ChangeCallback = (event: {
  type: "session_updated" | "session_created";
  sessionId: string;
  projectDir: string;
}) => void;

let watcher: fs.FSWatcher | null = null;
const listeners = new Set<ChangeCallback>();
// Per-session debounce timers — prevents one session's writes from swallowing another's events
const debounceTimers = new Map<string, NodeJS.Timeout>();

export function startWatching() {
  if (watcher) return;

  try {
    watcher = fs.watch(
      CLAUDE_DIR,
      { recursive: true },
      (eventType, filename) => {
        if (!filename || !filename.endsWith(".jsonl")) return;

        const parts = filename.split(path.sep);
        const projectDir = parts[0] || "";
        const sessionFile = parts[parts.length - 1];
        const sessionId = sessionFile.replace(".jsonl", "");

        // Validate it's a UUID
        if (
          !UUID_RE.test(sessionId)
        ) {
          return;
        }

        // Per-session debounce — Claude writes frequently during a session
        const existing = debounceTimers.get(sessionId);
        if (existing) clearTimeout(existing);

        debounceTimers.set(sessionId, setTimeout(() => {
          debounceTimers.delete(sessionId);

          const event = {
            type: eventType === "rename"
              ? ("session_created" as const)
              : ("session_updated" as const),
            sessionId,
            projectDir,
          };

          for (const listener of listeners) {
            try {
              listener(event);
            } catch {
              // ignore listener errors
            }
          }
        }, 2000));
      }
    );
  } catch {
    // fs.watch may not be available
  }
}

export function addChangeListener(callback: ChangeCallback) {
  listeners.add(callback);
  if (!watcher) startWatching();
  return () => listeners.delete(callback);
}

export function stopWatching() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
  listeners.clear();
}
