import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileSync = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ execFileSync }));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-build-manager-"));
const script = path.join(tmp, "mem-builds.sh");
fs.writeFileSync(script, "#!/bin/sh\nexit 0\n");
fs.chmodSync(script, 0o755);
const binary = path.join(tmp, "opencode");
fs.writeFileSync(binary, "#!/bin/sh\necho opencode v0.0.0-fork-at-deadbeef1234\n");
fs.chmodSync(binary, 0o755);
process.env.MEM_BUILDS_SCRIPT = script;

import {
  describeExecError,
  findBuildManagerScript,
  installBuild,
  readBuildState,
  rollbackBuild,
  shiftBuild,
} from "../opencode-build-manager";

const state = {
  dir: "/tmp/builds",
  current: "deadbeef1234",
  previous: null,
  builds: [{ sha: "deadbeef1234", version: "opencode v0.0.0-fork-at-deadbeef1234", installed: true, queued: true }],
};

/** Assert on the message directly: toThrow is unreliable under a mocked child_process. */
function errorOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to throw");
}

describe("OpenCode build manager bridge", () => {
  beforeEach(() => execFileSync.mockReset());

  it("locates the script from MEM_BUILDS_SCRIPT", () => {
    expect(findBuildManagerScript()).toBe(script);
  });

  it("parses the JSON state reported by list --json", () => {
    execFileSync.mockReturnValue(JSON.stringify(state));
    expect(readBuildState()).toEqual(state);
    expect(execFileSync.mock.calls[0][1]).toEqual(["list", "--json"]);
  });

  it("runs whitelisted commands with argument arrays, never a shell string", () => {
    execFileSync.mockReturnValue("ok");
    installBuild(binary);
    shiftBuild("deadbeef1234");
    rollbackBuild();
    expect(execFileSync.mock.calls.map((call) => call[1])).toEqual([
      ["install", binary],
      ["shift", "deadbeef1234"],
      ["rollback"],
    ]);
  });

  it("rejects non-absolute or missing binaries and malformed SHAs", () => {
    expect(errorOf(() => installBuild("opencode"))).toContain("absolute");
    expect(errorOf(() => installBuild(path.join(tmp, "nope")))).toContain("No such binary");
    expect(errorOf(() => shiftBuild("--evil"))).toContain("Invalid build SHA");
    expect(errorOf(() => shiftBuild("zzz"))).toContain("Invalid build SHA");
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("surfaces the script's stderr instead of a raw exit code", () => {
    expect(describeExecError({ stderr: "mem-builds: no previous build\n" })).toBe("mem-builds: no previous build");
    expect(describeExecError({ stdout: "from stdout\n" })).toBe("from stdout");
    expect(describeExecError(Buffer.from("buffered stderr\n"))).toBe("buffered stderr");
    expect(describeExecError(new Error("Command failed: mem-builds.sh rollback"))).toBe("Command failed: mem-builds.sh rollback");
    expect(describeExecError(undefined)).toBe("build manager failed");
  });
});
