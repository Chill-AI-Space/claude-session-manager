import { describe, expect, it } from "vitest";

import { assignCodexSessionIdsByCwd, type ActiveProcess } from "../process-detector";

describe("assignCodexSessionIdsByCwd", () => {
  it("matches the newest codex process in a cwd to the newest codex thread", () => {
    const processes: ActiveProcess[] = [
      {
        pid: 101,
        sessionId: null,
        cwd: "/tmp/repo",
        command: "node /opt/homebrew/bin/codex prompt",
        elapsedSecs: 40,
      },
      {
        pid: 102,
        sessionId: null,
        cwd: "/tmp/repo",
        command: "node /opt/homebrew/bin/codex prompt",
        elapsedSecs: 5,
      },
    ];

    assignCodexSessionIdsByCwd(
      processes,
      [
        { id: "older-thread", cwd: "/tmp/repo", updated_at: 100 },
        { id: "newer-thread", cwd: "/tmp/repo", updated_at: 200 },
      ],
      new Set()
    );

    expect(processes[0].sessionId).toBe("older-thread");
    expect(processes[1].sessionId).toBe("newer-thread");
  });

  it("does not reuse an already claimed thread id", () => {
    const processes: ActiveProcess[] = [
      {
        pid: 201,
        sessionId: "claimed-thread",
        cwd: "/tmp/repo",
        command: "node /opt/homebrew/bin/codex resume claimed-thread",
        elapsedSecs: 60,
      },
      {
        pid: 202,
        sessionId: null,
        cwd: "/tmp/repo",
        command: "node /opt/homebrew/bin/codex prompt",
        elapsedSecs: 3,
      },
    ];

    assignCodexSessionIdsByCwd(
      processes,
      [
        { id: "claimed-thread", cwd: "/tmp/repo", updated_at: 300 },
        { id: "available-thread", cwd: "/tmp/repo", updated_at: 200 },
      ],
      new Set(["claimed-thread"])
    );

    expect(processes[1].sessionId).toBe("available-thread");
  });
});
