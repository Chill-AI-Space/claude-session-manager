/**
 * Where a new session actually runs: the project folder first, then a fresh
 * git worktree off it.
 *
 * The order is the whole point. `resolveProjectPath()` redirects a
 * caller-supplied worktree/scratch path back to `~/Code/<repo>` — but it must
 * run BEFORE the worktree is created. Run it after, and it would resolve the
 * worktree we just made (which looks exactly like a session worktree) straight
 * back into the shared checkout, so the session would share a working tree with
 * every other session on the repo again.
 *
 * Kept free of DB imports so it is unit-testable; callers pass the resolved
 * worktree decision in.
 */
import { ProjectPathResolution, resolveProjectPath } from "./project-path";
import { PrepareResult, prepareSessionWorktree } from "./session-worktree";

export interface SessionStartResolution {
  /** Project folder the session was resolved to (before any worktree). */
  project: ProjectPathResolution;
  /** Null when isolation is off — nothing was created and nothing to log. */
  worktree: PrepareResult | null;
  /** Directory the agent runs in. */
  cwd: string;
}

export async function resolveSessionStart(
  requestedPath: string,
  message: string,
  opts: {
    useWorktree: boolean;
    findOriginUrl?: (repoName: string) => string | null | Promise<string | null>;
    /** Override for the code section (tests); defaults to `~/Code`. */
    codeRoot?: string;
    now?: Date;
  },
): Promise<SessionStartResolution> {
  const project = await resolveProjectPath(requestedPath, {
    findOriginUrl: opts.findOriginUrl,
    codeRoot: opts.codeRoot,
  });
  if (!opts.useWorktree) return { project, worktree: null, cwd: project.path };
  const worktree = await prepareSessionWorktree(project.path, message, opts.now);
  return { project, worktree, cwd: worktree.cwd };
}
