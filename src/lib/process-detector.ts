import { execSync } from "child_process";

export interface ActiveProcess {
  pid: number;
  sessionId: string | null;
  cwd: string | null;
  command: string;
}

// Cache active sessions for 5 seconds
let cachedResult: { processes: ActiveProcess[]; timestamp: number } | null =
  null;
const CACHE_TTL_MS = 5000;

export function detectActiveClaudeSessions(): ActiveProcess[] {
  // Return cache if fresh
  if (cachedResult && Date.now() - cachedResult.timestamp < CACHE_TTL_MS) {
    return cachedResult.processes;
  }

  try {
    // Find Claude CLI processes (not this app, not grep itself)
    const psOutput = execSync(
      'ps axo pid,command | grep -E "claude.*--resume|node.*/bin/claude " | grep -v grep | grep -v "claude-session-manager" | grep -v "next dev" | grep -v "claude-mermaid" | grep -v "claude-mcp"',
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

      // Extract session ID from --resume flag
      let sessionId: string | null = null;
      const resumeMatch = command.match(
        /--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/
      );
      if (resumeMatch) {
        sessionId = resumeMatch[1];
      }

      processes.push({ pid, sessionId, cwd: null, command });
    }

    // Single lsof call for all PIDs to find open JSONL files
    const pids = processes.map((p) => p.pid);
    if (pids.length > 0) {
      try {
        const lsofOutput = execSync(
          `lsof -p ${pids.join(",")} -Fpn 2>/dev/null || true`,
          { encoding: "utf-8", timeout: 3000 }
        );

        // Parse lsof output: p<pid>\nn<filename>\n
        let currentPid = 0;
        for (const line of lsofOutput.split("\n")) {
          if (line.startsWith("p")) {
            currentPid = parseInt(line.slice(1));
          } else if (line.startsWith("n")) {
            const filename = line.slice(1);
            const jsonlMatch = filename.match(
              /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/
            );
            if (jsonlMatch) {
              const proc = processes.find((p) => p.pid === currentPid);
              if (proc && !proc.sessionId) {
                proc.sessionId = jsonlMatch[1];
              }
            }
          }
        }
      } catch {
        // lsof may fail, that's ok
      }
    }

    cachedResult = { processes, timestamp: Date.now() };
    return processes;
  } catch {
    cachedResult = { processes: [], timestamp: Date.now() };
    return [];
  }
}

export function isSessionActive(sessionId: string): boolean {
  const active = detectActiveClaudeSessions();
  return active.some((p) => p.sessionId === sessionId);
}

export function getActiveSessionIds(): Set<string> {
  const active = detectActiveClaudeSessions();
  const ids = new Set<string>();
  for (const p of active) {
    if (p.sessionId) ids.add(p.sessionId);
  }
  return ids;
}

/**
 * Kill all running claude processes for a given session.
 * Returns the PIDs that were killed.
 */
export function killSessionProcesses(sessionId: string): number[] {
  cachedResult = null;
  const active = detectActiveClaudeSessions();
  const matching = active.filter((p) => p.sessionId === sessionId);

  const killed: number[] = [];
  for (const proc of matching) {
    try {
      process.kill(proc.pid, "SIGTERM");
      killed.push(proc.pid);
    } catch {
      // Process may have already exited
    }
  }

  cachedResult = null;
  return killed;
}
