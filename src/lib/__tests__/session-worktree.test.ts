import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  checkWorktreeRemovable,
  detectGitRepo,
  isPathInside,
  listSessionWorktrees,
  planWorktree,
  prepareSessionWorktree,
  removeSessionWorktree,
  resolveWorktreeDecision,
  slugFromMessage,
} from "../session-worktree";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

let tmp: string;
let repo: string;

beforeEach(() => {
  // realpath: macOS tmpdir is a /var → /private/var symlink, git reports the real path
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "csm-wt-")));
  repo = path.join(tmp, "myrepo");
  fs.mkdirSync(path.join(repo, "sub", "deep"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "sub", "deep", "f.txt"), "x");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("resolveWorktreeDecision", () => {
  it("explicit value always wins", () => {
    expect(resolveWorktreeDecision({ explicit: false, fromBrowser: false, settingDefault: "true" })).toBe(false);
    expect(resolveWorktreeDecision({ explicit: true, fromBrowser: true, settingDefault: "false" })).toBe(true);
    expect(resolveWorktreeDecision({ explicit: "false", fromBrowser: false, settingDefault: undefined })).toBe(false);
    expect(resolveWorktreeDecision({ explicit: "true", fromBrowser: true, settingDefault: undefined })).toBe(true);
  });
  it("browser starts follow the setting (default off)", () => {
    expect(resolveWorktreeDecision({ explicit: undefined, fromBrowser: true, settingDefault: "false" })).toBe(false);
    expect(resolveWorktreeDecision({ explicit: undefined, fromBrowser: true, settingDefault: undefined })).toBe(false);
    expect(resolveWorktreeDecision({ explicit: undefined, fromBrowser: true, settingDefault: "true" })).toBe(true);
  });
  it("sub-sessions (curl/API) get a worktree by default, whatever the setting says", () => {
    expect(resolveWorktreeDecision({ explicit: undefined, fromBrowser: false, settingDefault: "false" })).toBe(true);
    expect(resolveWorktreeDecision({ explicit: undefined, fromBrowser: false, settingDefault: undefined })).toBe(true);
    expect(resolveWorktreeDecision({ explicit: undefined, fromBrowser: false, settingDefault: "true" })).toBe(true);
  });
});

describe("detectGitRepo", () => {
  it("finds the root from the root and from a subfolder", async () => {
    expect(await detectGitRepo(repo)).toEqual({ root: repo, prefix: "", isLinkedWorktree: false });
    expect(await detectGitRepo(path.join(repo, "sub", "deep"))).toEqual({ root: repo, prefix: "sub/deep", isLinkedWorktree: false });
  });
  it("returns null outside a repo", async () => {
    const plain = path.join(tmp, "plain");
    fs.mkdirSync(plain);
    expect(await detectGitRepo(plain)).toBeNull();
  });
  it("flags linked worktrees", async () => {
    const wt = path.join(tmp, "linked");
    git(repo, "worktree", "add", "-q", "-b", "other", wt);
    expect((await detectGitRepo(wt))?.isLinkedWorktree).toBe(true);
  });
});

describe("naming", () => {
  it("slugs messages, transliterating cyrillic", () => {
    expect(slugFromMessage("Fix the auth bug in login.ts please!")).toBe("fix-the-auth-bug-in-login-ts");
    expect(slugFromMessage("Почини тесты")).toBe("pochini-testy");
    expect(slugFromMessage("!!! ???")).toBe("task");
    expect(slugFromMessage("a".repeat(80))).toHaveLength(30);
  });
  it("plans branch and folder next to the repo, preserving the subfolder", () => {
    const now = new Date(2026, 8, 28, 10, 5, 3);
    const plan = planWorktree({ root: repo, prefix: "sub/deep", isLinkedWorktree: false }, "Fix auth", now);
    expect(plan.branch).toBe("session/fix-auth-20260928-100503");
    expect(plan.dir).toBe(path.join(tmp, ".worktrees", "myrepo", "session-fix-auth-20260928-100503"));
    expect(plan.cwd).toBe(path.join(plan.dir, "sub", "deep"));
    expect(planWorktree({ root: repo, prefix: "", isLinkedWorktree: false }, "Fix auth", now, 2).branch)
      .toBe("session/fix-auth-20260928-100503-2");
  });
});

describe("prepareSessionWorktree", () => {
  it("falls back to the original path for a non-git folder", async () => {
    const plain = path.join(tmp, "plain");
    fs.mkdirSync(plain);
    const res = await prepareSessionWorktree(plain, "do stuff");
    expect(res).toEqual({ kind: "skipped", cwd: plain, reason: "not a git repository" });
  });

  it("does not nest worktrees", async () => {
    const wt = path.join(tmp, "linked");
    git(repo, "worktree", "add", "-q", "-b", "other", wt);
    const res = await prepareSessionWorktree(wt, "x");
    expect(res.kind).toBe("skipped");
    expect(res.cwd).toBe(wt);
  });

  it("creates two distinct worktrees for parallel starts and leaves the source checkout alone", async () => {
    fs.writeFileSync(path.join(repo, "dirty.txt"), "uncommitted");
    const statusBefore = git(repo, "status", "--porcelain");
    const now = new Date();
    const [a, b] = await Promise.all([
      prepareSessionWorktree(path.join(repo, "sub"), "same task", now),
      prepareSessionWorktree(path.join(repo, "sub"), "same task", now),
    ]);
    expect(a.kind).toBe("worktree");
    expect(b.kind).toBe("worktree");
    if (a.kind !== "worktree" || b.kind !== "worktree") return;
    expect(a.dir).not.toBe(b.dir);
    expect(a.branch).not.toBe(b.branch);
    expect(a.cwd).toBe(path.join(a.dir, "sub"));
    expect(fs.existsSync(path.join(a.dir, "sub", "deep", "f.txt"))).toBe(true);
    expect(fs.existsSync(path.join(a.dir, "dirty.txt"))).toBe(false);
    expect(git(repo, "status", "--porcelain")).toBe(statusBefore);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });
});

describe("cleanup checks", () => {
  it("keeps dirty or unpushed worktrees, removes clean ones", async () => {
    const res = await prepareSessionWorktree(repo, "cleanup me");
    if (res.kind !== "worktree") throw new Error("expected worktree");
    const [wt] = await listSessionWorktrees(repo);
    expect(wt.branch).toBe(res.branch);
    expect(isPathInside(res.cwd, wt.dir)).toBe(true);

    expect(await checkWorktreeRemovable(wt, true)).toEqual({ removable: false, reason: "session is active" });

    fs.writeFileSync(path.join(wt.dir, "new.txt"), "n");
    expect((await checkWorktreeRemovable(wt, false)).removable).toBe(false);

    git(wt.dir, "add", ".");
    git(wt.dir, "commit", "-q", "-m", "work");
    const unpushed = await checkWorktreeRemovable(wt, false);
    expect(unpushed.removable).toBe(false);
    expect(unpushed.reason).toMatch(/1 unpushed commit/);

    // Once the work is reachable from another branch it is safe to drop.
    git(repo, "branch", "keep", wt.branch);
    expect((await checkWorktreeRemovable(wt, false)).removable).toBe(true);
    await removeSessionWorktree(wt);
    expect(fs.existsSync(wt.dir)).toBe(false);
    expect(await listSessionWorktrees(repo)).toEqual([]);
  });

  it("a fresh untouched worktree is removable", async () => {
    await prepareSessionWorktree(repo, "fresh");
    const [wt] = await listSessionWorktrees(repo);
    expect(await checkWorktreeRemovable(wt, false)).toEqual({ removable: true, reason: "clean, no unpushed commits" });
  });
});
