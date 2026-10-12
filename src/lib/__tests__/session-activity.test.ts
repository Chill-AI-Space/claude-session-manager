import { describe, expect, it } from "vitest";
import { isSessionActiveForList } from "../session-activity";

const now = 1_000_000;

describe("session list activity", () => {
  it("shows a live Codex process even when its rollout stopped changing", () => {
    expect(isSessionActiveForList(
      { session_id: "codex-live", agent_type: "codex", file_mtime: 0 },
      new Set(["codex-live"]),
      now,
    )).toBe(true);
  });

  it("does not call a recently updated OpenCode session active without a process", () => {
    expect(isSessionActiveForList(
      { session_id: "opencode-dead", agent_type: "opencode", file_mtime: now },
      new Set(),
      now,
    )).toBe(false);
  });

  it("keeps Forge's recent-activity fallback until it has process detection", () => {
    expect(isSessionActiveForList(
      { session_id: "forge-recent", agent_type: "forge", file_mtime: now - 1_000 },
      new Set(),
      now,
    )).toBe(true);
  });
});
