/**
 * Fresh (uncached) "is there a live process for this session?" check.
 *
 * Used as the single gate before spawning `claude --resume <id>`: one session
 * must never have more than one live process. `detectActiveClaudeSessions()`
 * is not good enough for that — it is an 8s cache that returns [] when cold
 * (first call after a server restart, or right after killSessionProcesses()
 * nulls it), and for processes started without `--resume` it guesses the
 * session by the most recently modified transcript in the cwd. Both produced
 * resume clones of sessions whose original process was still running.
 *
 * Two sources, both read synchronously at call time:
 *   1. Claude Code's own registry `~/.claude/sessions/<pid>.json` ({ pid, sessionId })
 *      — authoritative even for interactive sessions started without `--resume`.
 *   2. `ps` command lines containing `--resume <id>` / `--session-id <id>`.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

export interface LiveSessionProcess {
  pid: number;
  /** Full command line when known (from ps); null when only the registry knew about it. */
  command: string | null;
  source: "registry" | "ps";
}

export interface LivenessDeps {
  /** Contents of ~/.claude/sessions/*.json (parsed). */
  readRegistry: () => Array<{ pid?: unknown; sessionId?: unknown }>;
  /** `ps axo pid=,command=` output. */
  psOutput: () => string;
  isPidAlive: (pid: number) => boolean;
  selfPid: number;
}

const SESSIONS_REGISTRY_DIR = path.join(os.homedir(), ".claude", "sessions");

function readRegistry(): Array<{ pid?: unknown; sessionId?: unknown }> {
  const out: Array<{ pid?: unknown; sessionId?: unknown }> = [];
  let files: string[];
  try {
    files = fs.readdirSync(SESSIONS_REGISTRY_DIR).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(SESSIONS_REGISTRY_DIR, f), "utf-8")));
    } catch { /* partially written / removed — skip */ }
  }
  return out;
}

function psOutput(): string {
  if (process.platform === "win32") return "";
  try {
    return execFileSync("ps", ["axo", "pid=,command="], { encoding: "utf-8", timeout: 3000, maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return "";
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but owned by someone else — still alive
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

const defaultDeps: LivenessDeps = { readRegistry, psOutput, isPidAlive, selfPid: process.pid };

/** Is this ps command line a claude process bound to `sessionId`? Pure — exported for tests. */
export function commandTargetsSession(command: string, sessionId: string): boolean {
  if (!command.includes(sessionId)) return false;
  // Only the CLI itself — `claude …` or `node …/claude …` — not a shell wrapper, grep, or tail of the jsonl
  const head = command.trim().split(/\s+/).slice(0, 2);
  if (!head.some((t) => /(^|[\\/])claude(\.exe)?$/.test(t) || /claude-code[\\/]cli\.m?js$/.test(t))) return false;
  const esc = sessionId.replace(/[-]/g, "\\-");
  return new RegExp(`(?:--resume|-r|--session-id)[\\s=]+${esc}(?![0-9a-f-])`).test(command);
}

/** All live processes currently bound to `sessionId`. Never cached. */
export function findLiveSessionProcesses(sessionId: string, deps: LivenessDeps = defaultDeps): LiveSessionProcess[] {
  if (!sessionId) return [];
  const found = new Map<number, LiveSessionProcess>();

  for (const entry of deps.readRegistry()) {
    const pid = typeof entry.pid === "number" ? entry.pid : NaN;
    if (entry.sessionId !== sessionId || !Number.isFinite(pid) || pid === deps.selfPid) continue;
    if (deps.isPidAlive(pid)) found.set(pid, { pid, command: null, source: "registry" });
  }

  for (const line of deps.psOutput().split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    if (pid === deps.selfPid || !commandTargetsSession(m[2], sessionId)) continue;
    found.set(pid, { pid, command: m[2], source: "ps" });
  }

  // Fill in command lines for registry hits so callers can inspect flags
  if ([...found.values()].some((p) => p.command === null)) {
    const byPid = new Map<number, string>();
    for (const line of deps.psOutput().split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (m) byPid.set(parseInt(m[1], 10), m[2]);
    }
    for (const p of found.values()) if (p.command === null) p.command = byPid.get(p.pid) ?? null;
  }

  return [...found.values()];
}

export function isSessionProcessAlive(sessionId: string, deps: LivenessDeps = defaultDeps): boolean {
  return findLiveSessionProcesses(sessionId, deps).length > 0;
}

/**
 * SIGTERM every live process of the session, then wait (up to `timeoutMs`)
 * until they are actually gone. Returns the pids still alive afterwards —
 * callers must NOT spawn a resume unless this is empty.
 */
export async function killSessionAndWait(
  sessionId: string,
  timeoutMs = 5000,
  deps: LivenessDeps = defaultDeps,
): Promise<{ killed: number[]; survivors: number[] }> {
  const killed: number[] = [];
  for (const p of findLiveSessionProcesses(sessionId, deps)) {
    try {
      process.kill(p.pid, "SIGTERM");
      killed.push(p.pid);
    } catch { /* already gone */ }
  }
  const deadline = Date.now() + timeoutMs;
  let survivors = killed.filter((pid) => deps.isPidAlive(pid));
  while (survivors.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    survivors = survivors.filter((pid) => deps.isPidAlive(pid));
  }
  // Anything else that appeared meanwhile also counts
  const others = findLiveSessionProcesses(sessionId, deps).map((p) => p.pid).filter((pid) => !survivors.includes(pid));
  return { killed, survivors: [...survivors, ...others] };
}
