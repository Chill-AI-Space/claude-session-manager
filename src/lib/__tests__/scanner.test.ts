import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { extractCodexRolloutIndex, extractCodexSearchText, readCodexMessagesPaginated } from "../codex-db";
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

describe("readCodexMessagesPaginated", () => {
  it("returns only the tail window and supports loading earlier batches", () => {
    const tempPath = writeTempRollout([
      { type: "event_msg", payload: { type: "user_message", message: "one" } },
      { type: "event_msg", payload: { type: "task_started" } },
      { type: "event_msg", payload: { type: "agent_message", message: "first" } },
      { type: "event_msg", payload: { type: "task_complete" } },
      { type: "event_msg", payload: { type: "user_message", message: "two" } },
      { type: "event_msg", payload: { type: "task_started" } },
      { type: "event_msg", payload: { type: "agent_message", message: "second" } },
      { type: "event_msg", payload: { type: "task_complete" } },
    ]);

    const tail = readCodexMessagesPaginated(tempPath, { pageSize: 2 });
    expect(tail.total).toBe(4);
    expect(tail.start).toBe(2);
    expect(tail.messages.map((message) => typeof message.content === "string" ? message.content : message.type)).toEqual([
      "two",
      "assistant",
    ]);

    const earlier = readCodexMessagesPaginated(tempPath, { pageSize: 2, before: tail.start });
    expect(earlier.total).toBe(4);
    expect(earlier.start).toBe(0);
    expect(earlier.messages.map((message) => typeof message.content === "string" ? message.content : message.type)).toEqual([
      "one",
      "assistant",
    ]);
  });
});
