/**
 * Remember the terminal TTY each session's process was attached to while it
 * was alive, so a babysitter/alarm resume can continue the session in the SAME
 * window instead of opening a new one.
 *
 * Written by the process detector on every refresh (it already has tty from
 * `ps` for every bound process); validated fresh at each use — TTY numbers are
 * recycled by the OS and windows get closed, so a cache hit alone is never
 * enough to type into.
 *
 * Survives Next.js hot reload via a globalThis singleton (same pattern as the
 * background scanners).
 */
import { execFileSync } from "child_process";

type TtyEntry = { tty: string; ts: number };
type GlobalWithTtyCache = typeof globalThis & { __sessionTtyCache?: Map<string, TtyEntry> };

/** After a day the cached TTY is more likely an OS-reused port than our window. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 1000;

export function rememberSessionTty(sessionId: string, tty: string | null | undefined): void {
  if (!sessionId || !tty) return;
  const g = globalThis as GlobalWithTtyCache;
  if (!g.__sessionTtyCache) g.__sessionTtyCache = new Map();
  const cache = g.__sessionTtyCache;
  // Bound the cache to avoid unbounded growth across sessions.
  if (cache.size >= MAX_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [k, v] of cache) {
      if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
    }
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(sessionId, { tty, ts: Date.now() });
}

/** Last known TTY for the session, or null when unknown/expired. */
export function getSessionTty(sessionId: string): string | null {
  const g = globalThis as GlobalWithTtyCache;
  const entry = g.__sessionTtyCache?.get(sessionId);
  if (!entry) return null;
  if (Date.now() - entry.ts > MAX_AGE_MS) {
    g.__sessionTtyCache?.delete(sessionId);
    return null;
  }
  return entry.tty;
}

export function forgetSessionTty(sessionId: string): void {
  (globalThis as GlobalWithTtyCache).__sessionTtyCache?.delete(sessionId);
}

// ── Fresh validation ─────────────────────────────────────────────────────────

export interface TtyDeps {
  /** Executable names attached to the TTY; throws when the TTY no longer exists. */
  listTtyComms: (tty: string) => string[];
  platform?: NodeJS.Platform;
}

function defaultListTtyComms(tty: string): string[] {
  // "/dev/ttys003" and "ttys003" are both accepted by ps -t; strip the prefix.
  const psTty = tty.replace(/^\/dev\//, "");
  const out = execFileSync("ps", ["-t", psTty, "-o", "comm="], {
    encoding: "utf-8",
    timeout: 3000,
  });
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

const AGENT_RE = /(^|[\/\s.-])(claude|codex|opencode|forge)(\.exe)?$/i;

/**
 * True when the TTY still exists, has a shell (or any inert process) at the
 * prompt, and NO agent process is attached — i.e. it is safe to type a resume
 * command into it. The window may be gone, or the TTY reused by the OS, or
 * another session's agent may be living there: all → false, caller falls back
 * to a fresh window.
 */
export function isTtyReadyForCommand(tty: string, deps: TtyDeps = { listTtyComms: defaultListTtyComms }): boolean {
  if ((deps.platform ?? process.platform) !== "darwin") return false;
  let comms: string[];
  try {
    comms = deps.listTtyComms(tty);
  } catch {
    return false; // ps exits non-zero when the tty no longer exists
  }
  if (comms.length === 0) return false;
  return !comms.some((c) => AGENT_RE.test(c));
}

// ── Launch verification ──────────────────────────────────────────────────────

/**
 * Pure: does this fresh `ps axo pid=,command=` output contain a live agent
 * process of `agentType` bound to `sessionId`?
 */
export function sessionProcessInPs(sessionId: string, agentType: string, psOutput: string): boolean {
  if (!sessionId) return false;
  const agentOk =
    agentType === "codex"
      ? /(^|[\/\s])codex(\s|$)/
      : agentType === "opencode"
        ? /(^|[\/\s])opencode(\s|$)/
        : null;
  if (!agentOk) return false;
  return psOutput.split("\n").some((line) => line.includes(sessionId) && agentOk.test(line));
}

/**
 * Poll a fresh ps until a live agent process for the session appears — the
 * confirmation that a command typed into a terminal actually launched it.
 * `timeoutMs` on false → caller falls back to opening a new window.
 */
export async function waitForSessionProcess(
  sessionId: string,
  agentType: string,
  opts: { timeoutMs?: number; intervalMs?: number; psOutput?: () => string } = {}
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const intervalMs = opts.intervalMs ?? 500;
  const psOutput =
    opts.psOutput ??
    (() => execFileSync("ps", ["axo", "pid=,command="], { encoding: "utf-8", timeout: 4000 }));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (sessionProcessInPs(sessionId, agentType, psOutput())) return true;
    } catch { /* ps hiccup — retry */ }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
