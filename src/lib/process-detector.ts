import { execSync, execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { claudeProjectsDir } from "./utils";
import type { CodexThreadRow } from "./codex-db";
import { listCodexThreads } from "./codex-db";

const isWin = process.platform === "win32";

// macOS/Linux: lsof lives in /usr/sbin which may not be in PATH (e.g. launchd)
const LSOF = process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof";

export interface ActiveProcess {
  pid: number;
  sessionId: string | null;
  cwd: string | null;
  command: string;
  elapsedSecs?: number | null;
  tty?: string | null;
}

export interface ProcessVitals {
  pid: number;
  cpu_percent: number;
  mem_mb: number;
  has_established_tcp: boolean;
  /** remote addresses of ESTABLISHED TCP connections, e.g. "1.2.3.4:443" */
  tcp_connections: string[];
  elapsed_secs: number;
}

// Short-lived cache for vitals (2 seconds) — fresh enough for UI polling at 4s
const vitalsCache = new Map<number, { vitals: ProcessVitals; ts: number }>();
const VITALS_TTL_MS = 2000;

// Cache active sessions for 5 seconds
let cachedResult: { processes: ActiveProcess[]; timestamp: number } | null = null;
const CACHE_TTL_MS = 5000;

const CLAUDE_DIR = claudeProjectsDir();

/** Convert a filesystem path to the hashed dir name Claude uses */
function pathToProjectDir(cwdPath: string): string {
  // Replace both / and \ with - (cross-platform)
  return cwdPath.replace(/[\\/]/g, "-");
}

function normalizePath(p: string): string {
  try {
    return path.resolve(p);
  } catch {
    return p;
  }
}

function isCodexCommand(command: string): boolean {
  return /(^|[\/\s])codex(\s|$)/.test(command);
}

function normalizePromptText(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        i += 1;
        current += command[i];
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    if (ch === "\\" && i + 1 < command.length) {
      i += 1;
      current += command[i];
      continue;
    }

    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}

function findCodexExecutableTokenIndex(tokens: string[]): number {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const base = path.basename(tokens[i]);
    if (base === "codex") return i;
  }
  return -1;
}

function extractCodexInitialPrompt(command: string): string | null {
  if (!isCodexCommand(command) || RESUME_RE.test(command)) return null;

  const tokens = tokenizeCommand(command);
  const execIdx = findCodexExecutableTokenIndex(tokens);
  if (execIdx < 0) return null;

  const args = tokens.slice(execIdx + 1);
  let i = 0;
  while (i < args.length) {
    const token = args[i];
    if (!token) {
      i += 1;
      continue;
    }
    if (token === "resume" || token === "--resume") return null;
    if (
      token === "--dangerously-bypass-approvals-and-sandbox" ||
      token === "--dangerously-skip-permissions"
    ) {
      i += 1;
      continue;
    }
    if (
      token === "-c" ||
      token === "--config" ||
      token === "--model" ||
      token === "--profile" ||
      token === "--approval-mode"
    ) {
      i += 2;
      continue;
    }
    if (token.startsWith("-")) {
      i += 1;
      continue;
    }
    break;
  }

  const prompt = normalizePromptText(args.slice(i).join(" "));
  return prompt || null;
}

/** Find the most recently modified JSONL session file in a project dir.
 *  Skips session IDs in `exclude` (already claimed by another process). */
function findMostRecentSession(projectDir: string, exclude?: Set<string>): string | null {
  const dir = path.join(CLAUDE_DIR, projectDir);
  try {
    const files = fs.readdirSync(dir).filter((f) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/.test(f)
    );
    if (files.length === 0) return null;

    let newest: { name: string; mtime: number } | null = null;
    for (const file of files) {
      const sessionId = file.replace(".jsonl", "");
      if (exclude?.has(sessionId)) continue;
      const mtime = fs.statSync(path.join(dir, file)).mtimeMs;
      if (!newest || mtime > newest.mtime) {
        newest = { name: file, mtime };
      }
    }
    return newest ? newest.name.replace(".jsonl", "") : null;
  } catch {
    return null;
  }
}

export function assignCodexSessionIdsByCwd(
  processes: ActiveProcess[],
  threads: Array<Pick<CodexThreadRow, "id" | "cwd" | "updated_at" | "first_user_message">>,
  claimed: Set<string>
) {
  const byCwd = new Map<string, Array<Pick<CodexThreadRow, "id" | "cwd" | "updated_at" | "first_user_message">>>();
  for (const thread of threads) {
    if (!thread.cwd) continue;
    const key = normalizePath(thread.cwd);
    const bucket = byCwd.get(key);
    if (bucket) bucket.push(thread);
    else byCwd.set(key, [thread]);
  }
  for (const bucket of byCwd.values()) {
    bucket.sort((a, b) => b.updated_at - a.updated_at);
  }

  type CodexProcessGroup = {
    cwd: string;
    tty: string | null;
    prompt: string | null;
    processes: ActiveProcess[];
    minElapsed: number;
  };

  const unresolvedGroups = new Map<string, CodexProcessGroup>();
  for (const proc of processes) {
    if (proc.sessionId || !proc.cwd || !isCodexCommand(proc.command)) continue;
    const cwd = normalizePath(proc.cwd);
    const tty = proc.tty ?? null;
    const prompt = extractCodexInitialPrompt(proc.command);
    const key = `${cwd}::${tty ?? "no-tty"}::${prompt ?? "no-prompt"}`;
    const existing = unresolvedGroups.get(key);
    if (existing) {
      existing.processes.push(proc);
      existing.minElapsed = Math.min(existing.minElapsed, proc.elapsedSecs ?? Number.MAX_SAFE_INTEGER);
    } else {
      unresolvedGroups.set(key, {
        cwd,
        tty,
        prompt,
        processes: [proc],
        minElapsed: proc.elapsedSecs ?? Number.MAX_SAFE_INTEGER,
      });
    }
  }

  const groups = Array.from(unresolvedGroups.values()).sort((a, b) => {
    if (a.cwd !== b.cwd) return a.cwd.localeCompare(b.cwd);
    if (a.minElapsed !== b.minElapsed) return a.minElapsed - b.minElapsed;
    return (a.tty ?? "").localeCompare(b.tty ?? "");
  });

  for (const group of groups) {
    const allCandidates = byCwd.get(group.cwd) ?? [];
    if (allCandidates.length === 0) continue;

    const normalizedPrompt = normalizePromptText(group.prompt);
    let matchedCandidates = normalizedPrompt
      ? allCandidates.filter((thread) => normalizePromptText(thread.first_user_message) === normalizedPrompt)
      : [];

    if (matchedCandidates.length === 0 && normalizedPrompt) {
      matchedCandidates = allCandidates.filter((thread) => {
        const threadPrompt = normalizePromptText(thread.first_user_message);
        return threadPrompt.length > 0 &&
          (normalizedPrompt.includes(threadPrompt) || threadPrompt.includes(normalizedPrompt));
      });
    }

    const fallbackCandidates = allCandidates.filter((thread) => !claimed.has(thread.id));
    const chosen = (matchedCandidates.length > 0 ? matchedCandidates : fallbackCandidates)
      .slice()
      .sort((a, b) => b.updated_at - a.updated_at)[0];
    if (!chosen) continue;

    for (const proc of group.processes) {
      proc.sessionId = chosen.id;
    }
    claimed.add(chosen.id);
  }
}

export function detectActiveClaudeSessions(): ActiveProcess[] {
  if (cachedResult && Date.now() - cachedResult.timestamp < CACHE_TTL_MS) {
    return cachedResult.processes;
  }

  try {
    const processes = isWin ? detectWindows() : detectUnix();

    // For processes without a session ID, find via most-recently-modified JSONL.
    // Build exclusion set from sessions already claimed by --resume processes so that
    // -p sessions in the same directory don't collide with an active --resume session.
    const claimed = new Set<string>(
      processes.filter((p) => p.sessionId).map((p) => p.sessionId!)
    );
    assignCodexSessionIdsByCwd(processes, listCodexThreads(), claimed);
    for (const proc of processes) {
      if (proc.sessionId || !proc.cwd) continue;
      const projectDir = pathToProjectDir(proc.cwd);
      proc.sessionId = findMostRecentSession(projectDir, claimed);
      if (proc.sessionId) claimed.add(proc.sessionId);
    }

    // Deduplicate: if multiple PIDs resolved to same session, keep the most
    // recently started process (usually the active resumed terminal).
    const bySessionId = new Map<string, ActiveProcess>();
    for (const proc of processes) {
      if (!proc.sessionId) continue;
      const prev = bySessionId.get(proc.sessionId);
      if (!prev) {
        bySessionId.set(proc.sessionId, proc);
        continue;
      }
      const prevElapsed = prev.elapsedSecs ?? Number.MAX_SAFE_INTEGER;
      const nextElapsed = proc.elapsedSecs ?? Number.MAX_SAFE_INTEGER;
      if (nextElapsed < prevElapsed || (nextElapsed === prevElapsed && proc.pid > prev.pid)) {
        bySessionId.set(proc.sessionId, proc);
      }
    }
    const unique = Array.from(bySessionId.values());

    cachedResult = { processes: unique, timestamp: Date.now() };
    return unique;
  } catch {
    cachedResult = { processes: [], timestamp: Date.now() };
    return [];
  }
}

/** Windows: use wmic to find claude.exe processes and their command lines */
function detectWindows(): ActiveProcess[] {
  const output = execSync(
    'wmic process where "name=\'claude.exe\'" get ProcessId,CommandLine /format:csv',
    { encoding: "utf-8", timeout: 5000 }
  ).trim();

  if (!output) return [];

  const processes: ActiveProcess[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("Node,")) continue;
    // CSV format: Node,CommandLine,ProcessId
    const parts = line.split(",");
    if (parts.length < 3) continue;
    const pid = parseInt(parts[parts.length - 1]);
    const command = parts.slice(1, -1).join(","); // CommandLine may contain commas

    if (isNaN(pid) || !command) continue;
    // Skip session manager's own processes
    if (command.includes("claude-session-manager") || command.includes("next dev")) continue;

    // Extract --resume UUID (Claude) or resume UUID (Codex)
    let sessionId: string | null = null;
    const resumeMatch = command.match(RESUME_RE);
    if (resumeMatch) sessionId = resumeMatch[1];

    processes.push({ pid, sessionId, cwd: null, command, elapsedSecs: null, tty: null });
  }

  return processes;
}

/** Regex matching both `--resume UUID` (Claude) and `resume UUID` (Codex) */
const RESUME_RE = /(?:--)?resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

/** Unix: use ps + lsof to find claude/codex processes and their CWDs */
function detectUnix(): ActiveProcess[] {
  const psOutput = execSync(
    'ps axo pid=,etime=,tty=,command= | grep -E "(/| |^)(claude|codex)( |$)" | grep -v grep | grep -v "claude-mermaid" | grep -v "claude-mcp" | grep -v "next dev"',
    { encoding: "utf-8", timeout: 3000 }
  ).trim();

  if (!psOutput) return [];

  const processes: ActiveProcess[] = [];
  for (const line of psOutput.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    const pid = parseInt(match[1]);
    const elapsedSecs = parseElapsedTime(match[2]);
    const tty = match[3] === "??" ? null : match[3];
    const command = match[4];

    let sessionId: string | null = null;
    const resumeMatch = command.match(RESUME_RE);
    if (resumeMatch) sessionId = resumeMatch[1];

    processes.push({ pid, sessionId, cwd: null, command, elapsedSecs, tty });
  }

  // Get CWDs for all PIDs in one lsof call
  const pids = processes.map((p) => p.pid);
  if (pids.length > 0) {
    try {
      const cwdOutput = execSync(
        `${LSOF} -p ${pids.join(",")} -a -d cwd -Fpn 2>/dev/null || true`,
        { encoding: "utf-8", timeout: 3000 }
      );

      let currentPid = 0;
      for (const line of cwdOutput.split("\n")) {
        if (line.startsWith("p")) {
          currentPid = parseInt(line.slice(1));
        } else if (line.startsWith("n")) {
          const cwd = line.slice(1);
          const proc = processes.find((p) => p.pid === currentPid);
          if (proc) proc.cwd = cwd;
        }
      }
    } catch {
      // lsof may fail
    }
  }

  return processes;
}

export function isSessionActive(sessionId: string): boolean {
  return detectActiveClaudeSessions().some((p) => p.sessionId === sessionId);
}

export function getActiveSessionIds(): Set<string> {
  return new Set(
    detectActiveClaudeSessions()
      .map((p) => p.sessionId)
      .filter((id): id is string => id !== null)
  );
}

/** Parse ps etime format [[dd-]hh:]mm:ss into seconds */
function parseElapsedTime(etime: string): number {
  const parts = etime.split(":");
  if (parts.length === 2) return parseInt(parts[0]) * 60 + parseInt(parts[1]);
  if (parts.length === 3) {
    const [h, m, s] = parts;
    // hh may include dd- prefix
    const hParts = h.split("-");
    const days = hParts.length === 2 ? parseInt(hParts[0]) * 86400 : 0;
    const hours = parseInt(hParts[hParts.length - 1]);
    return days + hours * 3600 + parseInt(m) * 60 + parseInt(s);
  }
  return 0;
}

/** Get CPU%, memory, and TCP connection vitals for a running process (Unix only).
 *  Returns null on Windows or if process is not found. */
export function getProcessVitals(pid: number): ProcessVitals | null {
  if (isWin) return null;
  const cached = vitalsCache.get(pid);
  if (cached && Date.now() - cached.ts < VITALS_TTL_MS) return cached.vitals;

  try {
    // Single ps call: pid, cpu%, rss (KB), elapsed time
    const psOut = execFileSync("ps", ["-p", String(pid), "-o", "pid=,pcpu=,rss=,etime="], {
      encoding: "utf-8",
      timeout: 2000,
    }).trim();
    if (!psOut) return null;

    const parts = psOut.trim().split(/\s+/);
    if (parts.length < 4) return null;
    const cpu_percent = parseFloat(parts[1]) || 0;
    const mem_mb = Math.round((parseInt(parts[2]) || 0) / 1024);
    const elapsed_secs = parseElapsedTime(parts[3]);

    // TCP connections via lsof — look for ESTABLISHED
    let has_established_tcp = false;
    const tcp_connections: string[] = [];
    try {
      const lsofOut = execSync(
        `${LSOF} -n -p ${pid} -i TCP 2>/dev/null || true`,
        { encoding: "utf-8", timeout: 2000 }
      );
      for (const line of lsofOut.split("\n")) {
        if (!line.includes("ESTABLISHED")) continue;
        has_established_tcp = true;
        // Last field is "local->remote (STATE)" — extract remote part
        const fields = line.trim().split(/\s+/);
        const addrField = fields[fields.length - 2] || ""; // e.g. "host:port->remote:port"
        const remote = addrField.includes("->") ? addrField.split("->")[1] : addrField;
        if (remote) tcp_connections.push(remote);
      }
    } catch { /* lsof may fail */ }

    const vitals: ProcessVitals = { pid, cpu_percent, mem_mb, has_established_tcp, tcp_connections, elapsed_secs };
    vitalsCache.set(pid, { vitals, ts: Date.now() });
    return vitals;
  } catch {
    return null;
  }
}

/** Get vitals for a session by its ID. Returns null if session is not active or on Windows. */
export function getSessionVitals(sessionId: string): ProcessVitals | null {
  const proc = detectActiveClaudeSessions().find((p) => p.sessionId === sessionId);
  if (!proc) return null;
  return getProcessVitals(proc.pid);
}

/**
 * Fallback for agents started without --resume (e.g. fresh Codex sessions).
 * Finds any detected process whose CWD matches projectPath and returns its vitals.
 */
export function getSessionVitalsByCwd(projectPath: string): ProcessVitals | null {
  if (isWin) return null;
  const proc = detectActiveClaudeSessions().find(
    (p) => p.cwd && (p.cwd === projectPath || p.cwd === projectPath.replace(/\\/g, "/"))
  );
  if (!proc) return null;
  return getProcessVitals(proc.pid);
}

export function killSessionProcesses(sessionId: string): number[] {
  cachedResult = null;
  const matching = detectActiveClaudeSessions().filter((p) => p.sessionId === sessionId);
  const killed: number[] = [];
  for (const proc of matching) {
    try {
      if (isWin) {
        execSync(`taskkill /PID ${proc.pid} /F`, { timeout: 5000 });
      } else {
        process.kill(proc.pid, "SIGTERM");
      }
      killed.push(proc.pid);
    } catch {
      // already exited
    }
  }
  cachedResult = null;
  return killed;
}
