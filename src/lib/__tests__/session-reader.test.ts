import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { readSessionMessages, readSessionMessagesPaginated } from "../session-reader";

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

describe("session-reader", () => {
  it("keeps tool_result-only user lines by attaching them to the preceding assistant message", () => {
    const tempPath = path.join(os.tmpdir(), `session-reader-${Date.now()}-${Math.random()}.jsonl`);
    tempPaths.push(tempPath);

    fs.writeFileSync(
      tempPath,
      [
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-1",
          timestamp: "2026-04-15T00:00:00.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/tmp/a.txt" } },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "user-tool-result-1",
          timestamp: "2026-04-15T00:00:01.000Z",
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tool-1", content: "file contents", is_error: false },
            ],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-2",
          timestamp: "2026-04-15T00:00:02.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
        }),
      ].join("\n"),
      "utf-8"
    );

    const messages = readSessionMessages(tempPath);
    expect(messages).toHaveLength(2);
    expect(messages[0].type).toBe("assistant");
    expect(Array.isArray(messages[0].content)).toBe(true);
    expect(messages[0].content).toEqual([
      { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/tmp/a.txt" } },
      { type: "tool_result", tool_use_id: "tool-1", content: "file contents" },
    ]);

    const page = readSessionMessagesPaginated(tempPath, { pageSize: 10 });
    expect(page.messages).toHaveLength(2);
    expect(page.messages[0].content).toEqual(messages[0].content);
  });
});
