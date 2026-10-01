import { execSync, execFileSync, exec } from "child_process";
import fs from "fs";
import path from "path";
import { claudeProjectsDir } from "./utils";
import type { CodexThreadRow } from "./codex-db";
import { listCodexThreads } from "./codex-db";
import { listIndexableOpencodeSessions, getOpencodeFirstUserMessage } from "./opencode-db";
import { findLiveSessionProcesses } from "./session-liveness";

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

// Vitals cache (ps call): 10s TTL — ps is cheap but no need to run on every 2s poll
const vitalsCache = new Map<number, { vitals: ProcessVitals; ts: number }>();
const VITALS_TTL_MS = 10_000;

// TCP state cache: updated asynchronously so lsof never blocks the event loop.
// lsof on a long-running Claude process with hundreds of TCP connections can take 150-500ms.
const tcpCache = new Map<number, { hasEstablished: boolean; connections: string[]; ts: number }>();
const TCP_TTL_MS = 15_000; // refresh TCP state at most once per 15s per PID
const tcpRefreshing = new Set<number>(); // prevent concurrent lsof runs for same PID

function refreshTcpAsync(pid: number): void {
  if (isWin || tcpRefreshing.has(pid)) return;
  const cached = tcpCache.get(pid);
  if (cached && Date.now() - cached.ts < TCP_TTL_MS) return;
  tcpRefreshing.add(pid);
  exec(`${LSOF} -n -p ${pid} -i TCP 2>/dev/null`, { timeout: 8000 }, (err, stdout) => {
    tcpRefreshing.delete(pid);
    const connections: string[] = [];
    let hasEstablished = false;
    if (!err && stdout) {
      for (const line of stdout.split("\n")) {
        if (!line.includes("ESTABLISHED")) continue;
        hasEstablished = true;
        const fields = line.trim().split(/\s+/);
        const addrField = fields[fields.length - 2] || "";
        const remote = addrField.includes("->") ? addrField.split("->")[1] : addrField;
        if (remote) connections.push(remote);
      }
    }
    tcpCache.set(pid, { hasEstablished, connections, ts: Date.now() });
  });
}

// Cache active sessions for 5 seconds.
// `processes` is deduped by session id (one representative per session — what
// the UI polls); `raw` keeps every bound process so killing a session can take
// out ALL its pids (e.g. an attached `opencode run -s …` next to its TUI).
let cachedResult: { processes: ActiveProcess[]; raw: ActiveProcess[]; timestamp: number } | null = null;
const CACHE_TTL_MS = 8000;

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

/**
 * True when the process IS the OpenCode CLI — argv[0] basename is `opencode`
 * (`/Users/…/.opencode/bin/opencode --auto --prompt …`). Ground truth on argv[0],
 * not a token match, so `vim opencode` or a claude prompt *mentioning* opencode
 * can never be treated as an OpenCode session.
 */
export function isOpencodeCommand(command: string): boolean {
  const first = command.trim().split(/\s+/)[0] ?? "";
  return first !== "" && path.basename(first) === "opencode";
}

/** `--session ses_…` (interactive attach/resume) or `run -s ses_…` (one-shot). */
const OPENCODE_SESSION_RE = /(?:--session|-s)\s+(ses_[0-9A-Za-z]+)/;

/**
 * OpenCode session id from argv, or null.
 * Session flags always precede the prompt text, so for the `--prompt` shape we
 * only search the head before `--prompt` — a prompt that *quotes*
 * `--session ses_…` can't steal the binding. For `run -s ses_ …` (no --prompt)
 * the flag sits right after `run`, so a short head covers it too.
 */
function extractOpencodeSessionId(command: string): string | null {
  if (!isOpencodeCommand(command)) return null;
  const promptIdx = command.indexOf("--prompt ");
  const head = promptIdx >= 0 ? command.slice(0, promptIdx) : command.slice(0, 160);
  const m = head.match(OPENCODE_SESSION_RE);
  return m ? m[1] : null;
}

/**
 * Initial prompt of a fresh `opencode --auto --prompt <text>` command, for
 * cwd+prompt session assignment. `ps` escapes embedded newlines as the literal
 * `\012`, which `normalizePromptText` alone would not collapse — undo that first.
 */
function extractOpencodeInitialPrompt(command: string): string | null {
  if (!isOpencodeCommand(command)) return null;
  if (extractOpencodeSessionId(command)) return null; // attached to an existing session
  const promptIdx = command.indexOf("--prompt ");
  if (promptIdx < 0) return null;
  const raw = command.slice(promptIdx + "--prompt ".length).replace(/\\012/g, "\n");
  const prompt = normalizePromptText(raw);
  return prompt || null;
}

/**
 * The ps grep is broad (agent names appear inside other commands' prompts) —
 * keep only lines that are actually an agent process: the OpenCode CLI on
 * argv[0], or a command containing a claude/codex token (exactly what matched
 * the grep before opencode was added to it).
 */
function isAgentProcessLine(command: string): boolean {
  return isOpencodeCommand(command) || /(^|[\/\s])(claude|codex)(\s|$)/.test(command);
}

/** Session id for a detected process — claude/codex resume UUIDs vs OpenCode `ses_` ids. */
function sessionIdFromCommand(command: string): string | null {
  const opencodeSession = extractOpencodeSessionId(command);
  if (opencodeSession) return opencodeSession;
  if (isOpencodeCommand(command)) return null; // opencode never uses claude/codex resume ids
  const resumeMatch = command.match(RESUME_RE);
  return resumeMatch ? resumeMatch[1] : null;
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

/** OpenCode session candidates for cwd-based assignment (from opencode.db). */
export interface OpencodeSessionCandidate {
  id: string;
  directory: string;
  time_created: number; // epoch ms
  time_updated: number; // epoch ms
  /** Pre-resolved first prompt when the caller has it; otherwise `opts.firstPromptOf`. */
  first_user_message?: string | null;
}

/**
 * Bind OpenCode processes started without `--session/-s` (`opencode --auto
 * --prompt …`) to a session in the same directory: exact prompt → substring →
 * nearest session start to the process start → most recently updated, always
 * skipping already-claimed ids. Pure logic, no I/O — prompts resolve lazily
 * via `opts.firstPromptOf` (opencode.db read, cached there).
 */
export function assignOpencodeSessionIdsByCwd(
  processes: ActiveProcess[],
  sessions: OpencodeSessionCandidate[],
  claimed: Set<string>,
  opts: { firstPromptOf?: (id: string) => string | null; now?: () => number } = {}
): void {
  const byCwd = new Map<string, OpencodeSessionCandidate[]>();
  for (const session of sessions) {
    if (!session.directory) continue;
    const key = normalizePath(session.directory);
    const bucket = byCwd.get(key);
    if (bucket) bucket.push(session);
    else byCwd.set(key, [session]);
  }
  for (const bucket of byCwd.values()) {
    bucket.sort((a, b) => b.time_updated - a.time_updated);
  }

  type OpencodeProcessGroup = {
    cwd: string;
    tty: string | null;
    prompt: string | null;
    processes: ActiveProcess[];
    minElapsed: number;
  };

  const unresolvedGroups = new Map<string, OpencodeProcessGroup>();
  for (const proc of processes) {
    if (proc.sessionId || !proc.cwd || !isOpencodeCommand(proc.command)) continue;
    const cwd = normalizePath(proc.cwd);
    const tty = proc.tty ?? null;
    const prompt = extractOpencodeInitialPrompt(proc.command);
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

  const nowMs = (opts.now ?? Date.now)();
  for (const group of unresolvedGroups.values()) {
    const candidates = byCwd.get(group.cwd) ?? [];
    if (candidates.length === 0) continue;
    const promptOf = (s: OpencodeSessionCandidate): string | null =>
      s.first_user_message ?? opts.firstPromptOf?.(s.id) ?? null;

    const normalizedPrompt = normalizePromptText(group.prompt);
    let matched = normalizedPrompt
      ? candidates.filter((s) => normalizePromptText(promptOf(s)) === normalizedPrompt)
      : [];

    if (matched.length === 0 && normalizedPrompt) {
      matched = candidates.filter((s) => {
        const candidatePrompt = normalizePromptText(promptOf(s));
        return (
          candidatePrompt.length > 0 &&
          (normalizedPrompt.includes(candidatePrompt) || candidatePrompt.includes(normalizedPrompt))
        );
      });
    }

    let chosen: OpencodeSessionCandidate | undefined;
    if (matched.length > 0) {
      chosen = matched.slice().sort((a, b) => b.time_updated - a.time_updated)[0];
    } else {
      const procStart = nowMs - (group.minElapsed === Number.MAX_SAFE_INTEGER ? 0 : group.minElapsed * 1000);
      chosen = candidates
        .filter((s) => !claimed.has(s.id))
        .sort(
          (a, b) =>
            Math.abs(a.time_created - procStart) - Math.abs(b.time_created - procStart) ||
            b.time_updated - a.time_updated
        )[0];
    }
    if (!chosen) continue;

    for (const proc of group.processes) {
      proc.sessionId = chosen.id;
    }
    claimed.add(chosen.id);
  }
}

/** Assign session IDs, deduplicate — pure logic, no I/O */
function finalizeProcesses(processes: ActiveProcess[]): ActiveProcess[] {
  const claimed = new Set<string>(
    processes.filter((p) => p.sessionId).map((p) => p.sessionId!)
  );
  assignCodexSessionIdsByCwd(processes, listCodexThreads(), claimed);
  assignOpencodeSessionIdsByCwd(processes, listIndexableOpencodeSessions(), claimed, {
    firstPromptOf: getOpencodeFirstUserMessage,
  });
  for (const proc of processes) {
    if (proc.sessionId || !proc.cwd) continue;
    if (isOpencodeCommand(proc.command)) continue; // OpenCode never owns a Claude JSONL session
    const projectDir = pathToProjectDir(proc.cwd);
    proc.sessionId = findMostRecentSession(projectDir, claimed);
    if (proc.sessionId) claimed.add(proc.sessionId);
  }
  const bySessionId = new Map<string, ActiveProcess>();
  for (const proc of processes) {
    if (!proc.sessionId) continue;
    const prev = bySessionId.get(proc.sessionId);
    if (!prev) { bySessionId.set(proc.sessionId, proc); continue; }
    const prevElapsed = prev.elapsedSecs ?? Number.MAX_SAFE_INTEGER;
    const nextElapsed = proc.elapsedSecs ?? Number.MAX_SAFE_INTEGER;
    if (nextElapsed < prevElapsed || (nextElapsed === prevElapsed && proc.pid > prev.pid)) {
      bySessionId.set(proc.sessionId, proc);
    }
  }
  return Array.from(bySessionId.values());
}

/** Async version of detectUnix: runs ps + lsof via exec() so it never blocks the event loop */
function detectUnixAsync(callback: (processes: ActiveProcess[]) => void): void {
  exec(
    'ps axo pid=,etime=,tty=,command= | grep -E "(/| |^)(claude|codex|opencode)( |$)" | grep -v grep | grep -v "claude-mermaid" | grep -v "claude-mcp" | grep -v "next dev"',
    { encoding: "utf-8", timeout: 3000 },
    (psErr, psOutput) => {
      if (psErr || !psOutput?.trim()) { callback([]); return; }
      const processes: ActiveProcess[] = [];
      for (const line of psOutput.trim().split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
        if (!match) continue;
        const pid = parseInt(match[1]);
        const elapsedSecs = parseElapsedTime(match[2]);
        const tty = match[3] === "??" ? null : match[3];
        const command = match[4];
        if (!isAgentProcessLine(command)) continue;
        processes.push({ pid, sessionId: sessionIdFromCommand(command), cwd: null, command, elapsedSecs, tty });
      }
      const pids = processes.map((p) => p.pid);
      if (pids.length === 0) { callback(processes); return; }
      exec(
        `${LSOF} -p ${pids.join(",")} -a -d cwd -Fpn 2>/dev/null || true`,
        { encoding: "utf-8", timeout: 3000 },
        (lsofErr, cwdOutput) => {
          if (!lsofErr && cwdOutput) {
            let currentPid = 0;
            for (const cwdLine of cwdOutput.split("\n")) {
              if (cwdLine.startsWith("p")) currentPid = parseInt(cwdLine.slice(1));
              else if (cwdLine.startsWith("n")) {
                const cwd = cwdLine.slice(1);
                const proc = processes.find((p) => p.pid === currentPid);
                if (proc) proc.cwd = cwd;
              }
            }
          }
          callback(processes);
        }
      );
    }
  );
}

let asyncRefreshRunning = false;

function scheduleAsyncRefresh(): void {
  if (asyncRefreshRunning || isWin) return;
  asyncRefreshRunning = true;
  detectUnixAsync((rawProcesses) => {
    try {
      cachedResult = { processes: finalizeProcesses(rawProcesses), raw: rawProcesses, timestamp: Date.now() };
    } catch {
      cachedResult = { processes: [], raw: [], timestamp: Date.now() };
    }
    asyncRefreshRunning = false;
  });
}

export function detectActiveClaudeSessions(): ActiveProcess[] {
  if (!cachedResult) {
    // No cache yet — trigger async build, return empty immediately
    scheduleAsyncRefresh();
    return [];
  }
  if (Date.now() - cachedResult.timestamp >= CACHE_TTL_MS) {
    scheduleAsyncRefresh(); // refresh in background, return stale now
  }
  return cachedResult.processes;
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
    'ps axo pid=,etime=,tty=,command= | grep -E "(/| |^)(claude|codex|opencode)( |$)" | grep -v grep | grep -v "claude-mermaid" | grep -v "claude-mcp" | grep -v "next dev"',
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
    if (!isAgentProcessLine(command)) continue;

    processes.push({ pid, sessionId: sessionIdFromCommand(command), cwd: null, command, elapsedSecs, tty });
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

    // TCP connections: read from async background cache, trigger refresh if stale.
    // Never blocks the event loop — lsof runs asynchronously.
    refreshTcpAsync(pid);
    const tcpState = tcpCache.get(pid);
    const has_established_tcp = tcpState?.hasEstablished ?? false;
    const tcp_connections = tcpState?.connections ?? [];

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
  // Fresh lookup: the cached detector returns [] when cold (it used to be nulled right here,
  // so this killed nothing and callers went on to spawn a --resume clone next to the survivor).
  // Prefer the RAW process list — every pid bound to this session (an attached
  // `opencode run -s …` shares its session with the TUI; dedupe would keep one).
  // Cold cache → one synchronous pass: OpenCode has no ~/.claude/sessions registry
  // fallback in findLiveSessionProcesses, so waiting for the async refresh would kill nothing.
  let source: ActiveProcess[] | undefined = cachedResult?.raw;
  if (!source || (cachedResult && Date.now() - cachedResult.timestamp >= CACHE_TTL_MS)) {
    try {
      const raw = detectUnix();
      const finalized = finalizeProcesses(raw);
      cachedResult = { processes: finalized, raw, timestamp: Date.now() };
      source = raw;
    } catch {
      source = source ?? [];
    }
  }
  const pids = new Set<number>(source.filter((p) => p.sessionId === sessionId).map((p) => p.pid));
  for (const p of findLiveSessionProcesses(sessionId)) pids.add(p.pid);
  const matching = [...pids].map((pid) => ({ pid }));
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
