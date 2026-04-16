import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { extractCodexRolloutIndex, extractCodexSearchText } from "../codex-db";
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

function writeTempRollout(lines: unknown[]): string {
  const tempPath = path.join(os.tmpdir(), `codex-search-${Date.now()}-${Math.random()}.jsonl`);
  tempPaths.push(tempPath);
  fs.writeFileSync(
    tempPath,
    lines.map((line) => JSON.stringify(line)).join("\n"),
    "utf-8"
  );
  return tempPath;
}

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
    const tempPath = writeTempRollout([
      { type: "event_msg", payload: { type: "user_message", message: "Find API bug" } },
      { type: "response_item", payload: { type: "function_call", name: "exec_command" } },
      { type: "event_msg", payload: { type: "agent_message", message: "I found the failing route" } },
      { type: "event_msg", payload: { type: "task_complete" } },
    ]);

    expect(extractCodexSearchText(tempPath)).toBe("Find API bug\nI found the failing route");
  });
});

describe("extractCodexRolloutIndex", () => {
  it("captures summary, search text, and completion in one pass", () => {
    const tempPath = writeTempRollout([
      { type: "event_msg", payload: { type: "user_message", message: "Find API bug" } },
      { type: "event_msg", payload: { type: "task_started" } },
      { type: "response_item", payload: { type: "function_call", name: "exec_command" } },
      { type: "event_msg", payload: { type: "agent_message", message: "I found the failing route" } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: "ok" } },
      { type: "event_msg", payload: { type: "task_complete" } },
    ]);

    expect(extractCodexRolloutIndex(tempPath)).toEqual({
      hasResult: true,
      searchText: "Find API bug\nI found the failing route",
      summary: {
        messageCount: 2,
        lastMessage: "I found the failing route",
        lastMessageRole: "assistant",
      },
    });
  });

  it("keeps tool-only assistant turns in the message count", () => {
    const tempPath = writeTempRollout([
      { type: "event_msg", payload: { type: "user_message", message: "Run the checks" } },
      { type: "event_msg", payload: { type: "task_started" } },
      { type: "response_item", payload: { type: "function_call", name: "exec_command" } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: "all green" } },
      { type: "event_msg", payload: { type: "task_complete" } },
    ]);

    expect(extractCodexRolloutIndex(tempPath)).toEqual({
      hasResult: true,
      searchText: "Run the checks",
      summary: {
        messageCount: 2,
        lastMessage: "",
        lastMessageRole: "assistant",
      },
    });
  });
});
