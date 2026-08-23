/**
 * Authoritative session_id -> live PID map, written by the global Stop hook
 * (~/.config/claude-hooks/plugins/Stop/telegram-notify.ts) every time a
 * session stops — the hook's own parent process IS that session's CLI.
 *
 * This sidesteps the ambiguous `detectActiveClaudeSessions()` heuristic
 * (guessing by most-recently-modified transcript in a shared cwd), which
 * misattributes when several sessions share a working directory.
 */
import { readFileSync } from "fs";
import { getTTY } from "./macos-terminal-control";

const PID_MAP_PATH = `${process.env.HOME}/.claude/session-pid-map.json`;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function getLiveSessionFromPidMap(sessionId: string): { pid: number; tty: string } | null {
  try {
    const map = JSON.parse(readFileSync(PID_MAP_PATH, "utf-8")) as Record<string, { pid: number }>;
    const entry = map[sessionId];
    if (!entry || !isPidAlive(entry.pid)) return null;
    const tty = getTTY(entry.pid);
    if (!tty) return null;
    return { pid: entry.pid, tty };
  } catch {
    return null;
  }
}
