import fs from "fs";
import path from "path";

const CLAUDE_DIR = path.join(
  process.env.HOME || "~",
  ".claude",
  "projects"
);

type ChangeCallback = (event: {
  type: "session_updated" | "session_created";
  sessionId: string;
  projectDir: string;
}) => void;

let watcher: fs.FSWatcher | null = null;
const listeners = new Set<ChangeCallback>();
let debounceTimer: NodeJS.Timeout | null = null;

export function startWatching() {
  if (watcher) return;

  try {
    watcher = fs.watch(
      CLAUDE_DIR,
      { recursive: true },
      (eventType, filename) => {
        if (!filename || !filename.endsWith(".jsonl")) return;

        // Debounce — Claude writes frequently during a session
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          const parts = filename.split(path.sep);
          const projectDir = parts[0] || "";
          const sessionFile = parts[parts.length - 1];
          const sessionId = sessionFile.replace(".jsonl", "");

          // Validate it's a UUID
          if (
            !sessionId.match(
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
            )
          ) {
            return;
          }

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
        }, 2000);
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
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  listeners.clear();
}
