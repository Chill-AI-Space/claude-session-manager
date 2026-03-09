import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { claudeProjectsDir } from "./utils";

export interface ActiveProcess {
  pid: number;
  sessionId: string | null;
  cwd: string | null;
  command: string;
}

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
  // Process detection requires Unix tools — skip on Windows
  if (process.platform === "win32") {
    cachedResult = { processes: [], timestamp: Date.now() };
    return [];
  }

  if (cachedResult && Date.now() - cachedResult.timestamp < CACHE_TTL_MS) {
    return cachedResult.processes;
  }

  try {
    // Step 1: find all claude CLI processes
    const psOutput = execSync(
      'ps axo pid,command | grep -E "(^| )claude( |$)" | grep -v grep | grep -v "claude-session-manager" | grep -v "claude-mermaid" | grep -v "claude-mcp" | grep -v "next dev"',
      { encoding: "utf-8", timeout: 3000 }
    ).trim();

    if (!psOutput) {
      cachedResult = { processes: [], timestamp: Date.now() };
      return [];
    }

    const processes: ActiveProcess[] = [];
    for (const line of psOutput.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) continue;
      const pid = parseInt(match[1]);
      const command = match[2];

      // Try --resume flag first (explicit session ID)
      let sessionId: string | null = null;
      const resumeMatch = command.match(
        /--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/
      );
      if (resumeMatch) sessionId = resumeMatch[1];

      processes.push({ pid, sessionId, cwd: null, command });
    }

    // Step 2: get CWDs for all PIDs in one lsof call
    const pids = processes.map((p) => p.pid);
    if (pids.length === 0) {
      cachedResult = { processes: [], timestamp: Date.now() };
      return [];
    }

    try {
      const cwdOutput = execSync(
        `lsof -p ${pids.join(",")} -a -d cwd -Fpn 2>/dev/null || true`,
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

    // Step 3: for processes without a session ID, find via most-recently-modified JSONL
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

export function killSessionProcesses(sessionId: string): number[] {
  if (process.platform === "win32") return [];
  cachedResult = null;
  const matching = detectActiveClaudeSessions().filter((p) => p.sessionId === sessionId);
  const killed: number[] = [];
  for (const proc of matching) {
    try {
      process.kill(proc.pid, "SIGTERM");
      killed.push(proc.pid);
    } catch {
      // already exited
    }
  }
  cachedResult = null;
  return killed;
}
