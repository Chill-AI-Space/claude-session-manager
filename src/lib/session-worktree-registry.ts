/**
 * DB/process side of per-session worktrees: remember which session runs in
 * which worktree, and the conservative cleanup (see session-worktree.ts).
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { getDb, logAction } from "./db";
import { getActiveSessionIds } from "./process-detector";
import { getOrchestrator } from "./orchestrator";
import {
  checkWorktreeRemovable,
  detectGitRepo,
  isPathInside,
  listSessionWorktrees,
  removeSessionWorktree,
  type SessionWorktree,
} from "./session-worktree";

const execFileAsync = promisify(execFile);

/**
 * Store the origin repo + branch on the session row. The row is created by
 * whichever start path the agent took (orchestrator placeholder, scanner,
 * codex/opencode insert) — possibly a moment after the session_id event, so
 * retry briefly until it shows up.
 */
export function recordSessionWorktree(sessionId: string, sourcePath: string, branch: string): void {
  const delays = [0, 1000, 3000, 10_000, 30_000];
  const attempt = (i: number) => {
    try {
      const res = getDb()
        .prepare("UPDATE sessions SET worktree_source_path = ?, worktree_branch = ? WHERE session_id = ?")
        .run(sourcePath, branch, sessionId);
      if (res.changes > 0) return;
    } catch { /* retry below */ }
    if (i + 1 < delays.length) setTimeout(() => attempt(i + 1), delays[i + 1]);
    else logAction("service", "session_worktree_record_failed", JSON.stringify({ sessionId, sourcePath, branch }), sessionId);
  };
  attempt(0);
}

/**
 * Wrap a start SSE stream: emit a status line first, and record the worktree
 * on the session row once its session_id event passes through.
 */
export function withWorktreeStatus(
  stream: ReadableStream,
  statusText: string,
  record?: { sourcePath: string; branch: string },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let recorded = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "status", text: statusText, status: statusText })}\n\n`));
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = typeof value === "string" ? value : decoder.decode(value, { stream: true });
          if (record && !recorded) {
            buffer = (buffer + chunk).slice(-4096);
            const m = buffer.match(/"type":"session_id","session_id":"([^"]+)"/);
            if (m) {
              recorded = true;
              recordSessionWorktree(m[1], record.sourcePath, record.branch);
            }
          }
          controller.enqueue(typeof value === "string" ? encoder.encode(value) : value);
        }
      } catch (err) {
        controller.error(err);
        return;
      }
      controller.close();
    },
    cancel(reason) {
      return stream.cancel(reason);
    },
  });
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

export interface WorktreeCleanupEntry extends SessionWorktree {
  sessionIds: string[];
  removable: boolean;
  reason: string;
  removed?: boolean;
}

/** cwd of every running process (Unix). null when it can't be determined. */
async function processCwds(): Promise<string[] | null> {
  if (process.platform === "win32") return null;
  const lsof = process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof";
  try {
    const { stdout } = await execFileAsync(lsof, ["-nP", "-d", "cwd", "-Fn"], { timeout: 15_000, maxBuffer: 50 * 1024 * 1024 });
    return stdout.split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1));
  } catch (err) {
    // lsof exits 1 when some processes can't be inspected but still prints the rest.
    const stdout = (err as { stdout?: string }).stdout;
    if (stdout) return stdout.split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1));
    return null;
  }
}

const LIVE_PHASES = new Set(["running", "retrying", "continuing", "stalled"]);

/**
 * List (dryRun) or clean up session worktrees of every repo that ever had one.
 * A worktree is removed only if it is clean, its branch has no unpushed
 * commits, and no session/process is using it. Everything else is kept and
 * reported with the reason.
 */
export async function cleanupSessionWorktrees(dryRun: boolean): Promise<WorktreeCleanupEntry[]> {
  const db = getDb();
  const sourceRoots = (db
    .prepare("SELECT DISTINCT worktree_source_path AS p FROM sessions WHERE worktree_source_path IS NOT NULL")
    .all() as { p: string }[]).map((r) => r.p);

  const roots = new Set<string>();
  for (const p of sourceRoots) {
    const repo = await detectGitRepo(p).catch(() => null);
    if (repo) roots.add(repo.root);
  }

  const sessions = db
    .prepare("SELECT session_id, project_path FROM sessions WHERE worktree_branch IS NOT NULL OR project_path LIKE '%.worktrees%'")
    .all() as { session_id: string; project_path: string }[];
  const activeIds = getActiveSessionIds();
  for (const s of getOrchestrator().getAllStates()) {
    if (LIVE_PHASES.has(s.phase)) activeIds.add(s.sessionId);
  }
  const cwds = await processCwds();

  const entries: WorktreeCleanupEntry[] = [];
  for (const root of roots) {
    let worktrees: SessionWorktree[];
    try {
      worktrees = await listSessionWorktrees(root);
    } catch {
      continue;
    }
    for (const wt of worktrees) {
      const sessionIds = sessions.filter((s) => isPathInside(s.project_path, wt.dir)).map((s) => s.session_id);
      const busyProcess = cwds?.some((c) => isPathInside(c, wt.dir)) ?? false;
      const active = busyProcess || sessionIds.some((id) => activeIds.has(id));
      const check = await checkWorktreeRemovable(wt, active);
      if (active && busyProcess) check.reason = "a process is running inside it";
      const entry: WorktreeCleanupEntry = { ...wt, sessionIds, ...check };
      if (!dryRun && check.removable) {
        try {
          await removeSessionWorktree(wt);
          entry.removed = true;
        } catch (err) {
          entry.removed = false;
          entry.reason = `remove failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      entries.push(entry);
    }
  }
  if (!dryRun) {
    logAction("service", "session_worktree_cleanup", JSON.stringify({
      removed: entries.filter((e) => e.removed).map((e) => e.dir),
      kept: entries.filter((e) => !e.removed).map((e) => ({ dir: e.dir, reason: e.reason })),
    }));
  }
  return entries;
}
