import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { extractCodexSearchText } from "../codex-db";
import { shouldSkipSessionIncremental } from "../scanner";

const tempPaths: string[] = [];

afterEach(() => {
  for (const tempPath of tempPaths.splice(0)) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup
    }
  }
});

describe("shouldSkipSessionIncremental", () => {
  it("skips unchanged sessions only when FTS index already exists", () => {
    expect(shouldSkipSessionIncremental(1000, 1000, true)).toBe(true);
    expect(shouldSkipSessionIncremental(1000, 1500, true)).toBe(true);
    expect(shouldSkipSessionIncremental(1000, 1999, true)).toBe(true);
  });

  it("forces a rescan when the FTS row is missing", () => {
    expect(shouldSkipSessionIncremental(1000, 1000, false)).toBe(false);
    expect(shouldSkipSessionIncremental(1000, 1500, false)).toBe(false);
  });

  it("rescans when the file changed materially", () => {
    expect(shouldSkipSessionIncremental(1000, 2001, true)).toBe(false);
  });
});

describe("extractCodexSearchText", () => {
  it("indexes only user and assistant text from Codex rollout events", () => {
    const tempPath = path.join(os.tmpdir(), `codex-search-${Date.now()}-${Math.random()}.jsonl`);
    tempPaths.push(tempPath);
    fs.writeFileSync(
      tempPath,
      [
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Find API bug" } }),
        JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "exec_command" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "I found the failing route" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
      ].join("\n"),
      "utf-8"
    );

    expect(extractCodexSearchText(tempPath)).toBe("Find API bug\nI found the failing route");
  });
});
