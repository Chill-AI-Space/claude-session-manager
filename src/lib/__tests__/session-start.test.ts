import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveProjectPath } from "../project-path";
import { resolveSessionStart } from "../session-start";
import { worktreesBaseDir } from "../session-worktree";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

let tmp: string;
let code: string;
let project: string;

beforeEach(() => {
  // realpath: macOS tmpdir is a /var → /private/var symlink, git reports the real path
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "csm-start-")));
  code = path.join(tmp, "code");
  project = path.join(code, "myrepo");
  fs.mkdirSync(project, { recursive: true });
  git(project, "init", "-q", "-b", "main");
  git(project, "config", "user.email", "t@t");
  git(project, "config", "user.name", "t");
  fs.writeFileSync(path.join(project, "f.txt"), "x");
  git(project, "add", ".");
  git(project, "commit", "-q", "-m", "init");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A session worktree of `project`, laid out the way the Session Manager lays them out. */
function makeSessionWorktree(leaf: string): string {
  const dir = path.join(worktreesBaseDir(project), leaf);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(project, "worktree", "add", "-q", "-b", `session/${leaf}`, dir);
  return dir;
}

describe("resolveSessionStart", () => {
  it("puts a sub-session in its own worktree, not in the shared checkout", async () => {
    const res = await resolveSessionStart(project, "fix the bug", { useWorktree: true, codeRoot: code });
    expect(res.worktree?.kind).toBe("worktree");
    if (res.worktree?.kind !== "worktree") return;

    expect(res.cwd).toBe(res.worktree.cwd);
    expect(res.cwd).not.toBe(project);
    expect(res.cwd.startsWith(worktreesBaseDir(project))).toBe(true);
    expect(res.worktree.branch).toMatch(/^session\/fix-the-bug-/);
    expect(res.worktree.sourcePath).toBe(project);
    expect(fs.existsSync(path.join(res.cwd, "f.txt"))).toBe(true);
    // The shared checkout is untouched: same branch, same clean tree.
    expect(git(project, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(project, "status", "--porcelain")).toBe("");
  });

  it("gives parallel sub-sessions distinct worktrees", async () => {
    const [a, b] = await Promise.all([
      resolveSessionStart(project, "same task", { useWorktree: true, codeRoot: code }),
      resolveSessionStart(project, "same task", { useWorktree: true, codeRoot: code }),
    ]);
    expect(a.cwd).not.toBe(b.cwd);
    expect(a.worktree?.kind).toBe("worktree");
    expect(b.worktree?.kind).toBe("worktree");
    if (a.worktree?.kind !== "worktree" || b.worktree?.kind !== "worktree") return;
    expect(a.worktree.branch).not.toBe(b.worktree.branch);
  });

  it("never resolves the worktree it just created back into the shared checkout", async () => {
    const res = await resolveSessionStart(project, "fix the bug", { useWorktree: true, codeRoot: code });
    if (res.worktree?.kind !== "worktree") throw new Error("expected a worktree");

    // The hazard is real: resolveProjectPath() does treat a session worktree as a
    // scratch path and would send the session back to the project folder…
    const reresolved = await resolveProjectPath(res.cwd, { codeRoot: code });
    expect(reresolved.redirected).toBe(true);
    expect(reresolved.path).toBe(project);

    // …so the composition must not feed its own output back in. The agent cwd is
    // the fresh worktree, and the project folder is not where the session lands.
    expect(res.cwd).not.toBe(reresolved.path);
    expect(res.cwd).toBe(res.worktree.dir);
  });

  it("redirects a caller-supplied worktree path, then isolates off the project folder", async () => {
    const foreign = makeSessionWorktree("someone-else");
    const res = await resolveSessionStart(foreign, "my task", { useWorktree: true, codeRoot: code });
    expect(res.project.redirected).toBe(true);
    expect(res.project.path).toBe(project);
    expect(res.worktree?.kind).toBe("worktree");
    if (res.worktree?.kind !== "worktree") return;
    expect(res.cwd).not.toBe(foreign);
    expect(res.cwd.startsWith(worktreesBaseDir(project))).toBe(true);
  });

  it("runs in the project folder when isolation is off, creating nothing", async () => {
    const res = await resolveSessionStart(project, "my task", { useWorktree: false, codeRoot: code });
    expect(res.cwd).toBe(project);
    expect(res.worktree).toBeNull();
    expect(res.project.redirected).toBe(false);
    expect(fs.existsSync(worktreesBaseDir(project))).toBe(false);
  });

  it("falls back to the requested path when it is not a git repo", async () => {
    const plain = path.join(tmp, "plain");
    fs.mkdirSync(plain);
    const res = await resolveSessionStart(plain, "my task", { useWorktree: true, codeRoot: code });
    expect(res.cwd).toBe(plain);
    expect(res.worktree?.kind).toBe("skipped");
  });
});
