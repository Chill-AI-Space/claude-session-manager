/**
 * Where a new session should actually run.
 *
 * A caller may hand us any folder — including a per-session git worktree
 * (`~/Code/.worktrees/<repo>/<slug>-<ts>`) or a stray worktree under /tmp.
 * Those are scratch checkouts, not projects: spawning there produces a pile of
 * meaningless folders and sessions that can't see each other's work.
 *
 * Rule:
 *   1. If the path is a session/linked worktree, find the project that owns it
 *      and run there instead — `~/Code/<repo>` first, else the owning checkout.
 *   2. If that project folder doesn't exist anywhere, create it in the code
 *      section: `git clone <origin>` when the URL is known, otherwise `mkdir`.
 *   3. Any ordinary (non-worktree) path is returned untouched.
 *
 * Never throws — on any problem it returns the requested path plus a note,
 * the same contract `prepareSessionWorktree()` uses.
 */
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { detectGitRepo } from "./session-worktree";

const execFileAsync = promisify(execFile);

/** `…/.worktrees/<repo>/…` — the session-worktree base layout. */
const WORKTREE_SEGMENT = /[\\/]\.worktrees[\\/]([^\\/]+)(?:[\\/]|$)/;

export interface ProjectPathResolution {
  /** Directory the agent should run in. */
  path: string;
  /** True when this differs from what the caller asked for. */
  redirected: boolean;
  /** True when the folder had to be created (clone or mkdir). */
  created: boolean;
  /** Human-readable note for the SSE status line and logs. */
  note?: string;
}

/** The "code" section — where project folders live (`~/Code`). */
export function codeRoot(): string {
  const home = os.homedir();
  const direct = path.join(home, "Code");
  if (fs.existsSync(direct)) return direct;
  return findDirCaseInsensitive(home, "Code") ?? direct;
}

function findDirCaseInsensitive(root: string, name: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return null;
  }
  const hit = entries.find((e) => e.toLowerCase() === name.toLowerCase());
  if (!hit) return null;
  const full = path.join(root, hit);
  try {
    return fs.statSync(full).isDirectory() ? full : null;
  } catch {
    return null;
  }
}

function git(cwd: string, args: string[]): Promise<string> {
  return execFileAsync("git", ["-C", cwd, ...args], {
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  }).then(({ stdout }) => stdout.replace(/\r?\n$/, ""));
}

/** Repo name from a `…/.worktrees/<repo>/…` path segment, else null. */
export function worktreeSegmentRepo(p: string): string | null {
  const m = p.match(WORKTREE_SEGMENT);
  return m ? m[1] : null;
}

/** Main checkout of the repo `dir` belongs to (`--git-common-dir` parent), else null. */
async function mainCheckoutRoot(dir: string): Promise<string | null> {
  try {
    const common = await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (!common) return null;
    const root = path.dirname(common);
    return fs.existsSync(root) ? root : null;
  } catch {
    return null;
  }
}

/** `origin` URL of the repo at `dir`, or null when it isn't a repo / has no origin. */
export async function originUrl(dir: string): Promise<string | null> {
  try {
    const url = await git(dir, ["remote", "get-url", "origin"]);
    return url || null;
  } catch {
    return null;
  }
}

function isSameDir(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/**
 * Resolve the folder a session should start in.
 *
 * @param requestedPath path from the start request (may be a worktree, may not exist)
 * @param opts.codeRoot override for the code section (tests); defaults to `~/Code`
 * @param opts.findOriginUrl resolve a clone URL by repo name when the requested
 *   path itself is gone (the caller knows past project paths, this module doesn't)
 */
export async function resolveProjectPath(
  requestedPath: string,
  opts: {
    codeRoot?: string;
    findOriginUrl?: (repoName: string) => string | null | Promise<string | null>;
  } = {},
): Promise<ProjectPathResolution> {
  const root = opts.codeRoot ?? codeRoot();
  const requested = path.resolve(requestedPath);
  const unchanged = (note?: string): ProjectPathResolution => ({
    path: requested,
    redirected: false,
    created: false,
    note,
  });

  const segmentRepo = worktreeSegmentRepo(requested);
  const repo = await detectGitRepo(requested);
  const isLinked = Boolean(repo?.isLinkedWorktree);
  const exists = isDirectory(requested);
  // Ordinary existing folder — nothing to resolve.
  if (!segmentRepo && !isLinked && exists) return unchanged();

  const mainRoot = repo ? await mainCheckoutRoot(requested) : null;
  const repoName = segmentRepo ?? (mainRoot ? path.basename(mainRoot) : path.basename(requested));

  // 1. The project folder in the code section.
  const existing = findDirCaseInsensitive(root, repoName);
  if (existing && !isSameDir(existing, requested)) {
    return { path: existing, redirected: true, created: false, note: `project folder: ${existing}` };
  }

  // 2. The checkout that owns this worktree, when it lives outside the code section.
  if (mainRoot && !isSameDir(mainRoot, requested)) {
    return { path: mainRoot, redirected: true, created: false, note: `owning checkout: ${mainRoot}` };
  }

  // 3. Nothing to spawn into — create the project folder in the code section.
  const target = path.join(root, repoName);
  if (isSameDir(target, requested)) return exists ? unchanged() : unchanged(`no project folder for ${repoName}`);
  try {
    fs.mkdirSync(root, { recursive: true });
    const url =
      (repo ? await originUrl(requested) : null) ??
      (opts.findOriginUrl ? await opts.findOriginUrl(repoName) : null);
    if (url) {
      await execFileAsync("git", ["clone", "--", url, target], {
        timeout: 120_000,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { path: target, redirected: true, created: true, note: `cloned ${url} → ${target}` };
    }
    fs.mkdirSync(target, { recursive: true });
    return { path: target, redirected: true, created: true, note: `created ${target}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return unchanged(`project folder not created (${msg.trim().split(/\r?\n/).slice(-1)[0]}) — running in ${requested}`);
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
