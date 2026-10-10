import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { parseOpencodeBuilds, resolveOpencodeBuild } from "../opencode-builds";

const settings = vi.hoisted(() => ({ value: "[]" }));
vi.mock("../db", () => ({ getSetting: () => settings.value }));
vi.mock("../opencode-bin", () => ({ getOpencodePath: () => "installed-opencode" }));
const build = { id: "pr-42", name: "PR 42", binary: path.join(os.tmpdir(), "opencode-test"), kind: "snapshot" };

describe("OpenCode build registry", () => {
  it("sorts upstream, stable, then newest snapshots", () => {
    const entries = [
      { ...build, id: "old", builtAt: "2026-01-01" },
      { ...build, id: "stable", kind: "stable" },
      { ...build, id: "new", builtAt: "2026-10-10" },
      { ...build, id: "classic", kind: "upstream" },
    ];
    expect(parseOpencodeBuilds(JSON.stringify(entries)).map((b) => b.id)).toEqual(["classic", "stable", "new", "old"]);
  });
  it("rejects duplicate IDs and commands instead of absolute binary paths", () => {
    expect(() => parseOpencodeBuilds(JSON.stringify([build, build]))).toThrow();
    expect(() => parseOpencodeBuilds(JSON.stringify([{ ...build, binary: "opencode --flag" }]))).toThrow();
  });
  it("keeps legacy launches and refuses missing builds instead of falling back", () => {
    expect(resolveOpencodeBuild()).toEqual({ binary: "installed-opencode", autoFlag: true });
    expect(() => resolveOpencodeBuild("deleted")).toThrow("Unknown OpenCode build");
    settings.value = JSON.stringify([build]);
    vi.spyOn(fs, "statSync").mockImplementation(() => { throw new Error("missing"); });
    expect(() => resolveOpencodeBuild(build.id)).toThrow("unavailable");
    vi.restoreAllMocks();
  });
  it("upstream defaults to no fork-only --auto flag", () => {
    settings.value = JSON.stringify([{ ...build, kind: "upstream" }]);
    vi.spyOn(fs, "statSync").mockReturnValue({ isFile: () => true } as fs.Stats);
    vi.spyOn(fs, "accessSync").mockImplementation(() => {});
    expect(resolveOpencodeBuild(build.id).autoFlag).toBe(false);
    vi.restoreAllMocks();
  });
});
