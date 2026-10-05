import { describe, expect, it } from "vitest";
import { FALLBACK_AGENT, isAgentType } from "../agents";

describe("isAgentType", () => {
  it("accepts every agent the UI can pick", () => {
    for (const agent of ["claude", "forge", "codex", "opencode"]) {
      expect(isAgentType(agent)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    for (const value of ["", "gpt", undefined, null, 42, {}, ["opencode"]]) {
      expect(isAgentType(value)).toBe(false);
    }
  });
});

describe("FALLBACK_AGENT", () => {
  // A composer that renders one agent while /api/sessions/start defaults to
  // another means the picker lies about the session it is about to create —
  // that's exactly what happened when the sync effect's hand-written list
  // quietly left `opencode` out while the setting was "opencode".
  it("is itself a valid agent", () => {
    expect(isAgentType(FALLBACK_AGENT)).toBe(true);
  });
});