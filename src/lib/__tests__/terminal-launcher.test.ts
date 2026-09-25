import fs from "fs";
import { describe, expect, it } from "vitest";

import { wrapLongCommand } from "../terminal-launcher";

describe("wrapLongCommand", () => {
  it("leaves a short single-line command untouched", () => {
    const cmd = `cd '/tmp/project' && opencode --prompt "hi"`;
    expect(wrapLongCommand(cmd)).toBe(cmd);
  });

  it("wraps commands longer than iTerm2's write-text limit into a temp script", () => {
    const cmd = `echo '${"A".repeat(1200)}'`;
    const wrapped = wrapLongCommand(cmd);

    expect(wrapped).toMatch(/^bash \S+csm-launch-.*\.sh$/);

    const scriptPath = wrapped.replace(/^bash /, "");
    expect(fs.readFileSync(scriptPath, "utf8")).toContain(cmd);
    fs.unlinkSync(scriptPath);
  });

  it("wraps short commands that contain newlines (write-text turns them into Enter)", () => {
    const cmd = `echo line1\necho line2`;
    const wrapped = wrapLongCommand(cmd);

    expect(wrapped).toMatch(/^bash \S+csm-launch-.*\.sh$/);
    const scriptPath = wrapped.replace(/^bash /, "");
    expect(fs.readFileSync(scriptPath, "utf8")).toContain(cmd);
    fs.unlinkSync(scriptPath);
  });
});
