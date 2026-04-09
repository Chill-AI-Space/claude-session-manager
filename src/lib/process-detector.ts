import { execSync, execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { claudeProjectsDir } from "./utils";

const isWin = process.platform === "win32";

// macOS/Linux: lsof lives in /usr/sbin which may not be in PATH (e.g. launchd)
const LSOF = process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof";

export interface ActiveProcess {
  pid: number;
  sessionId: string | null;
  cwd: string | null;
  command: string;
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

/** Find the most recently modified JSONL session file in a project dir */
function findMostRecentSession(projectDir: string): string | null {
  const dir = path.join(CLAUDE_DIR, projectDir);
  try {
    const files = fs.readdirSync(dir).filter((f) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/.test(f)
    );
    if (files.length === 0) return null;

    let newest: { name: string; mtime: number } | null = null;
    for (const file of files) {
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

export function detectActiveClaudeSessions(): ActiveProcess[] {
  if (cachedResult && Date.now() - cachedResult.timestamp < CACHE_TTL_MS) {
    return cachedResult.processes;
  }

  try {
    const processes = isWin ? detectWindows() : detectUnix();

    // For processes without a session ID, find via most-recently-modified JSONL
    for (const proc of processes) {
      if (proc.sessionId || !proc.cwd) continue;
      const projectDir = pathToProjectDir(proc.cwd);
      proc.sessionId = findMostRecentSession(projectDir);
    }

    // Deduplicate: if multiple PIDs resolved to same session, keep one
    const seen = new Set<string>();
    const unique = processes.filter((p) => {
      if (!p.sessionId) return false;
      if (seen.has(p.sessionId)) return false;
      seen.add(p.sessionId);
      return true;
    });

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

    // Extract --resume session ID (ASCII UUID — unaffected by encoding)
    let sessionId: string | null = null;
    const resumeMatch = command.match(
      /--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/
    );
    if (resumeMatch) sessionId = resumeMatch[1];

    processes.push({ pid, sessionId, cwd: null, command });
  }

  return processes;
}

/** Unix: use ps + lsof to find claude processes and their CWDs */
function detectUnix(): ActiveProcess[] {
  const psOutput = execSync(
    'ps axo pid,command | grep -E "(/| |^)claude( |$)" | grep -v grep | grep -v "claude-session-manager" | grep -v "claude-mermaid" | grep -v "claude-mcp" | grep -v "next dev"',
    { encoding: "utf-8", timeout: 3000 }
  ).trim();

  if (!psOutput) return [];

  const processes: ActiveProcess[] = [];
  for (const line of psOutput.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = parseInt(match[1]);
    const command = match[2];

    let sessionId: string | null = null;
    const resumeMatch = command.match(
      /--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/
    );
    if (resumeMatch) sessionId = resumeMatch[1];

    processes.push({ pid, sessionId, cwd: null, command });
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
