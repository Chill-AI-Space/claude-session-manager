/**
 * Per-session git worktree isolation.
 *
 * Parallel sessions started on the same repo path would otherwise share one
 * working tree (checkouts, stashes and uncommitted changes collide). When
 * enabled, /api/sessions/start creates `git worktree add -b session/<slug>-<ts>`
 * next to the repo and runs the agent there. Agent-agnostic: the Session Manager
 * does it, not `claude -w`.
 *
 * Never touches the source checkout: only `git worktree add` (which creates a
 * new branch + directory) is run against it.
 *
 * Kept free of DB imports so it is unit-testable; callers pass DB-derived data in.
 */
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const SESSION_BRANCH_PREFIX = "session/";

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.replace(/\r?\n$/, "");
}

// ── Decision ────────────────────────────────────────────────────────────────

/**
 * Explicit `worktree` in the request body always wins. Otherwise: browser UI
 * starts follow the `sessions_worktree_default` setting (default off), while
 * sub-sessions (curl/API — no Sec-Fetch-* headers) default to on.
 */
export function resolveWorktreeDecision(opts: {
  explicit: unknown;
  fromBrowser: boolean;
  settingDefault: string | undefined;
}): boolean {
  if (typeof opts.explicit === "boolean") return opts.explicit;
  if (opts.explicit === "true") return true;
  if (opts.explicit === "false") return false;
  if (opts.fromBrowser) return opts.settingDefault === "true";
  return true;
}

// ── Git detection ───────────────────────────────────────────────────────────

export interface GitRepoInfo {
  /** Top-level of the working tree containing `dir`. */
  root: string;
  /** Path of `dir` relative to root ("" when dir is the root). */
  prefix: string;
  /** True when `dir` is inside a linked worktree (not the main checkout). */
  isLinkedWorktree: boolean;
}

/** Returns null when `dir` is not inside a git working tree. */
export async function detectGitRepo(dir: string): Promise<GitRepoInfo | null> {
  let out: string;
  try {
    out = await git(dir, [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-dir",
      "--git-common-dir",
      "--show-prefix",
    ]);
  } catch {
    return null;
  }
  const [root, gitDir, commonDir, prefix = ""] = out.split(/\r?\n/);
  if (!root || !gitDir || !commonDir) return null;
  return {
    root: path.resolve(root),
    prefix: prefix.replace(/[\\/]+$/, ""),
    isLinkedWorktree: path.resolve(gitDir) !== path.resolve(commonDir),
  };
}

// ── Naming ──────────────────────────────────────────────────────────────────

const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/** Short ascii slug from the first words of the task message ("task" if nothing usable). */
export function slugFromMessage(message: string, maxLen = 30): string {
  const translit = message
    .toLowerCase()
    .split("")
    .map((ch) => CYRILLIC[ch] ?? ch)
    .join("");
  const words = translit
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let slug = "";
  for (const w of words) {
    const next = slug ? `${slug}-${w}` : w;
    if (next.length > maxLen) break;
    slug = next;
  }
  if (!slug && words[0]) slug = words[0].slice(0, maxLen);
  return slug || "task";
}

function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface WorktreePlan {
  branch: string;
  /** Worktree root directory. */
  dir: string;
  /** Where the agent starts (dir + the subfolder prefix the caller asked for). */
  cwd: string;
}

/**
 * Branch `session/<slug>-<YYYYMMDD-HHMMSS>[-N]`, directory
 * `<repo-root>/../.worktrees/<repo-name>/<branch with / → ->`.
 * `attempt` > 1 adds a suffix (collision on parallel starts within the same second).
 */
export function planWorktree(repo: GitRepoInfo, message: string, now = new Date(), attempt = 1): WorktreePlan {
  const suffix = attempt > 1 ? `-${attempt}` : "";
  const branch = `${SESSION_BRANCH_PREFIX}${slugFromMessage(message)}-${timestamp(now)}${suffix}`;
  const dir = path.join(worktreesBaseDir(repo.root), branch.replace(/\//g, "-"));
  const cwd = repo.prefix ? path.join(dir, repo.prefix) : dir;
  return { branch, dir, cwd };
}

/** `<repo-root>/../.worktrees/<repo-name>` — outside the repo so it never shows in its git status. */
export function worktreesBaseDir(repoRoot: string): string {
  return path.join(path.dirname(repoRoot), ".worktrees", path.basename(repoRoot));
}

// ── Create ──────────────────────────────────────────────────────────────────

export type PrepareResult =
  | { kind: "worktree"; cwd: string; dir: string; branch: string; sourceRoot: string; sourcePath: string }
  | { kind: "skipped"; cwd: string; reason: string };

/**
 * Create a worktree for a new session started at `projectPath`. Never throws:
 * on any problem it returns `skipped` with the original path and a reason.
 */
export async function prepareSessionWorktree(projectPath: string, message: string, now = new Date()): Promise<PrepareResult> {
  const repo = await detectGitRepo(projectPath);
  if (!repo) return { kind: "skipped", cwd: projectPath, reason: "not a git repository" };
  if (repo.isLinkedWorktree) {
    return { kind: "skipped", cwd: projectPath, reason: "path is already a linked git worktree" };
  }

  let lastErr = "";
  for (let attempt = 1; attempt <= 5; attempt++) {
    const plan = planWorktree(repo, message, now, attempt);
    if (fs.existsSync(plan.dir)) {
      lastErr = `directory already exists: ${plan.dir}`;
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(plan.dir), { recursive: true });
      // `worktree add -b` locks the new ref, so two parallel starts cannot both win the same name.
      await git(repo.root, ["worktree", "add", "-b", plan.branch, plan.dir, "HEAD"]);
      // A subfolder that only exists untracked in the source won't exist in the worktree.
      const cwd = fs.existsSync(plan.cwd) ? plan.cwd : plan.dir;
      return { kind: "worktree", cwd, dir: plan.dir, branch: plan.branch, sourceRoot: repo.root, sourcePath: projectPath };
    } catch (err) {
      lastErr = errText(err);
      if (!/already exists/i.test(lastErr)) break;
    }
  }
  return { kind: "skipped", cwd: projectPath, reason: `git worktree add failed: ${lastErr}` };
}

function errText(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e?.stderr || e?.message || String(err)).trim().split(/\r?\n/).slice(-3).join(" ");
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

export interface SessionWorktree {
  dir: string;
  branch: string;
  sourceRoot: string;
}

/** Session worktrees (branch `session/*`) registered in a source repo. */
export async function listSessionWorktrees(sourceRoot: string): Promise<SessionWorktree[]> {
  const out = await git(sourceRoot, ["worktree", "list", "--porcelain"]);
  const result: SessionWorktree[] = [];
  for (const block of out.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const dir = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
    const ref = lines.find((l) => l.startsWith("branch "))?.slice("branch ".length);
    if (!dir || !ref?.startsWith(`refs/heads/${SESSION_BRANCH_PREFIX}`)) continue;
    result.push({ dir: path.resolve(dir), branch: ref.slice("refs/heads/".length), sourceRoot });
  }
  return result;
}

export interface CleanupCheck {
  removable: boolean;
  reason: string;
}

/**
 * Conservative removability check. Blocks when the worktree has any
 * modified/untracked files, when the branch has commits that exist nowhere
 * else (not on any remote-tracking ref and not on any other local branch),
 * or when `isActive` says a session/process is still using it.
 */
export async function checkWorktreeRemovable(wt: SessionWorktree, isActive: boolean): Promise<CleanupCheck> {
  if (isActive) return { removable: false, reason: "session is active" };
  const missing = !fs.existsSync(wt.dir);
  try {
    if (!missing) {
      const status = await git(wt.dir, ["status", "--porcelain", "--untracked-files=all"]);
      if (status.trim()) {
        const n = status.split(/\r?\n/).filter(Boolean).length;
        return { removable: false, reason: `${n} uncommitted/untracked file(s)` };
      }
    }
    const branchName = wt.branch;
    const unique = await git(wt.sourceRoot, [
      "rev-list", "--count", `refs/heads/${branchName}`,
      "--not", `--exclude=${branchName}`, "--branches", "--remotes",
    ]);
    const count = parseInt(unique, 10) || 0;
    if (count > 0) return { removable: false, reason: `${count} unpushed commit(s) on ${branchName}` };
  } catch (err) {
    return { removable: false, reason: `check failed: ${errText(err)}` };
  }
  return { removable: true, reason: missing ? "directory is missing (stale entry), no unpushed commits" : "clean, no unpushed commits" };
}

/** Remove a worktree + its branch. Only call after checkWorktreeRemovable() said yes. */
export async function removeSessionWorktree(wt: SessionWorktree): Promise<void> {
  if (fs.existsSync(wt.dir)) {
    // No --force: git itself refuses if the tree became dirty in the meantime.
    await git(wt.sourceRoot, ["worktree", "remove", wt.dir]);
  } else {
    await git(wt.sourceRoot, ["worktree", "prune"]);
  }
  // -D is safe here: the check guaranteed every commit is reachable from another ref.
  await git(wt.sourceRoot, ["branch", "-D", wt.branch]);
}

/** True when `child` is `parent` or inside it. */
export function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}
