import { describe, expect, it } from "vitest";

import { commandTargetsSession, findLiveSessionProcesses, type LivenessDeps } from "../session-liveness";

const SID = "51192f90-4a03-4c79-9f94-90320dc2496c";

function deps(over: Partial<LivenessDeps>): LivenessDeps {
  return { readRegistry: () => [], psOutput: () => "", isPidAlive: () => true, selfPid: 1, ...over };
}

describe("commandTargetsSession", () => {
  it("matches the claude CLI resuming the session", () => {
    expect(commandTargetsSession(`/Users/vova/.local/bin/claude --resume ${SID} --dangerously-skip-permissions`, SID)).toBe(true);
    expect(commandTargetsSession(`node /opt/homebrew/bin/claude -p --resume ${SID}`, SID)).toBe(true);
    expect(commandTargetsSession(`claude --session-id ${SID}`, SID)).toBe(true);
  });

  it("ignores shell wrappers, log tails and other sessions", () => {
    expect(commandTargetsSession(`/bin/zsh -c cd /x && claude --resume ${SID}`, SID)).toBe(false);
    expect(commandTargetsSession(`tail -f ~/.claude/projects/x/${SID}.jsonl`, SID)).toBe(false);
    expect(commandTargetsSession(`claude --resume aaaaaaaa-4a03-4c79-9f94-90320dc2496c`, SID)).toBe(false);
  });
});

describe("findLiveSessionProcesses", () => {
  it("finds an interactive session started WITHOUT --resume via ~/.claude/sessions registry", () => {
    const live = findLiveSessionProcesses(SID, deps({
      readRegistry: () => [{ pid: 80391, sessionId: SID }, { pid: 5, sessionId: "other" }],
      psOutput: () => "80391 /Users/vova/.local/bin/claude --dangerously-skip-permissions\n",
    }));
    expect(live.map((p) => p.pid)).toEqual([80391]);
    expect(live[0].command).toContain("--dangerously-skip-permissions");
  });

  it("finds resume processes via ps and dedups by pid", () => {
    const live = findLiveSessionProcesses(SID, deps({
      readRegistry: () => [{ pid: 66870, sessionId: SID }],
      psOutput: () => `66870 /Users/vova/.local/bin/claude --resume ${SID} -p hi\n75906 /Users/vova/.local/bin/claude --resume ${SID} -p hi\n`,
    }));
    expect(live.map((p) => p.pid).sort()).toEqual([66870, 75906]);
  });

  it("ignores dead registry entries and its own pid", () => {
    const live = findLiveSessionProcesses(SID, deps({
      readRegistry: () => [{ pid: 111, sessionId: SID }],
      isPidAlive: () => false,
      psOutput: () => `1 claude --resume ${SID}\n`,
    }));
    expect(live).toEqual([]);
  });
});
