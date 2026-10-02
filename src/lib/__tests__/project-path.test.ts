import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveProjectPath, worktreeSegmentRepo } from "../project-path";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

function makeRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "f.txt"), "x");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
}

/** The layout Session Manager creates: main checkout + `.worktrees/<repo>/<leaf>`. */
function makeSessionWorktree(main: string, leaf: string): string {
  const wt = path.join(path.dirname(main), ".worktrees", path.basename(main), leaf);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(main, "worktree", "add", "-q", "-b", `session/${leaf}`, wt);
  return wt;
}

let tmp: string;
let code: string;
let work: string;

beforeEach(() => {
  // realpath: macOS tmpdir is a /var → /private/var symlink, git reports the real path
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "csm-pp-")));
  code = path.join(tmp, "code");
  work = path.join(tmp, "work");
  fs.mkdirSync(code);
  fs.mkdirSync(work);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("worktreeSegmentRepo", () => {
  it("reads the repo name out of a .worktrees path", () => {
    expect(worktreeSegmentRepo("/u/code/.worktrees/myrepo/session-abc")).toBe("myrepo");
    expect(worktreeSegmentRepo("/u/code/.worktrees/myrepo")).toBe("myrepo");
    expect(worktreeSegmentRepo("/u/code/.worktrees/myrepo/sub/leaf/deep")).toBe("myrepo");
  });
  it("returns null outside a .worktrees path", () => {
    expect(worktreeSegmentRepo("/u/code/myrepo")).toBeNull();
    expect(worktreeSegmentRepo("/u/code/other/.worktree/myrepo")).toBeNull();
  });
});

describe("resolveProjectPath", () => {
  it("leaves an ordinary folder alone", async () => {
    const plain = path.join(tmp, "plain");
    fs.mkdirSync(plain);
    const r = await resolveProjectPath(plain, { codeRoot: code });
    expect(r).toEqual({ path: plain, redirected: false, created: false, note: undefined });
  });

  it("leaves the main checkout alone", async () => {
    const main = path.join(code, "myrepo");
    makeRepo(main);
    const r = await resolveProjectPath(main, { codeRoot: code });
    expect(r.path).toBe(main);
    expect(r.redirected).toBe(false);
  });

  it("maps a session worktree back onto its project folder", async () => {
    const main = path.join(code, "myrepo");
    makeRepo(main);
    const wt = makeSessionWorktree(main, "session-abc");

    const r = await resolveProjectPath(wt, { codeRoot: code });
    expect(r).toMatchObject({ path: main, redirected: true, created: false });
  });

  it("maps a worktree path onto the project folder even when the leaf is gone", async () => {
    const main = path.join(code, "myrepo");
    makeRepo(main);
    const gone = path.join(path.dirname(main), ".worktrees", "myrepo", "session-deleted");

    const r = await resolveProjectPath(gone, { codeRoot: code });
    expect(r).toMatchObject({ path: main, redirected: true, created: false });
  });

  it("maps a linked worktree outside .worktrees onto its project folder", async () => {
    const main = path.join(code, "myrepo");
    makeRepo(main);
    const wt = path.join(tmp, "scratch", "wt");
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(main, "worktree", "add", "-q", "-b", "other", wt);

    const r = await resolveProjectPath(wt, { codeRoot: code });
    expect(r).toMatchObject({ path: main, redirected: true, created: false });
  });

  it("falls back to the owning checkout when no folder exists in the code section", async () => {
    const main = path.join(work, "myrepo");
    makeRepo(main);
    const wt = path.join(work, "scratch-wt");
    git(main, "worktree", "add", "-q", "-b", "other", wt);

    const r = await resolveProjectPath(wt, { codeRoot: code });
    expect(r).toMatchObject({ path: main, redirected: true, created: false });
    expect(r.note).toContain("owning checkout");
  });

  it("creates the project folder in the code section for a path that does not exist", async () => {
    const missing = path.join(tmp, "scratch", "newproj");

    const r = await resolveProjectPath(missing, { codeRoot: code });
    expect(r).toMatchObject({ path: path.join(code, "newproj"), redirected: true, created: true });
    expect(fs.statSync(path.join(code, "newproj")).isDirectory()).toBe(true);
  });

  it("redirects a missing path onto an existing project of the same name", async () => {
    const known = path.join(code, "known");
    makeRepo(known);
    const missing = path.join(tmp, "elsewhere", "known");

    const r = await resolveProjectPath(missing, { codeRoot: code });
    expect(r).toMatchObject({ path: known, redirected: true, created: false });
    expect(fs.existsSync(path.join(code, "known", "f.txt"))).toBe(true);
  });

  it("does not invent a folder inside the code section that is already the target", async () => {
    const missing = path.join(code, "ghost");

    const r = await resolveProjectPath(missing, { codeRoot: code });
    expect(r.redirected).toBe(false);
    expect(r.created).toBe(false);
    expect(r.path).toBe(missing);
    expect(r.note).toContain("no project folder");
  });

  it("clones from a known origin when the project folder is missing", async () => {
    const origin = path.join(tmp, "origin", "myrepo");
    makeRepo(origin);
    const gone = path.join(tmp, "gone", ".worktrees", "myrepo", "session-x");

    const r = await resolveProjectPath(gone, {
      codeRoot: code,
      findOriginUrl: (name) => (name === "myrepo" ? origin : null),
    });
    expect(r).toMatchObject({ path: path.join(code, "myrepo"), redirected: true, created: true });
    expect(fs.readFileSync(path.join(code, "myrepo", "f.txt"), "utf-8")).toBe("x");
    expect(fs.existsSync(path.join(code, "myrepo", ".git"))).toBe(true);
  });

  it("keeps running in the requested path when the project folder cannot be created", async () => {
    const missing = path.join(tmp, "gone", ".worktrees", "myrepo", "session-x");

    const r = await resolveProjectPath(missing, {
      codeRoot: code,
      findOriginUrl: () => path.join(tmp, "does-not-exist"),
    });
    expect(r).toMatchObject({ path: missing, redirected: false, created: false });
    expect(r.note).toContain("project folder not created");
  });
});
