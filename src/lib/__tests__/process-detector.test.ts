import { describe, expect, it } from "vitest";

import { assignCodexSessionIdsByCwd, type ActiveProcess } from "../process-detector";

describe("assignCodexSessionIdsByCwd", () => {
  it("keeps parent and child codex processes on the same tty mapped to one matching thread", () => {
    const processes: ActiveProcess[] = [
      {
        pid: 101,
        sessionId: null,
        cwd: "/tmp/repo",
        tty: "ttys001",
        command: "node /opt/homebrew/bin/codex Привет мир",
        elapsedSecs: 40,
      },
      {
        pid: 102,
        sessionId: null,
        cwd: "/tmp/repo",
        tty: "ttys001",
        command: "/opt/homebrew/libexec/codex Привет мир",
        elapsedSecs: 39,
      },
    ];

    assignCodexSessionIdsByCwd(
      processes,
      [
        { id: "other-thread", cwd: "/tmp/repo", updated_at: 100, first_user_message: "Something else" },
        { id: "target-thread", cwd: "/tmp/repo", updated_at: 200, first_user_message: "Привет мир" },
      ],
      new Set()
    );

    expect(processes[0].sessionId).toBe("target-thread");
    expect(processes[1].sessionId).toBe("target-thread");
  });

  it("prefers exact prompt matches over newer unrelated threads in the same cwd", () => {
    const processes: ActiveProcess[] = [
      {
        pid: 201,
        sessionId: null,
        cwd: "/tmp/repo",
        tty: "ttys002",
        command: "node /opt/homebrew/bin/codex current prompt",
        elapsedSecs: 5,
      },
    ];

    assignCodexSessionIdsByCwd(
      processes,
      [
        { id: "newest-unrelated", cwd: "/tmp/repo", updated_at: 300, first_user_message: "other prompt" },
        { id: "matching-thread", cwd: "/tmp/repo", updated_at: 200, first_user_message: "current prompt" },
      ],
      new Set()
    );

    expect(processes[0].sessionId).toBe("matching-thread");
  });

  it("does not reuse an already claimed thread id", () => {
    const processes: ActiveProcess[] = [
      {
        pid: 301,
        sessionId: "claimed-thread",
        cwd: "/tmp/repo",
        tty: "ttys003",
        command: "node /opt/homebrew/bin/codex resume claimed-thread",
        elapsedSecs: 60,
      },
      {
        pid: 302,
        sessionId: null,
        cwd: "/tmp/repo",
        tty: "ttys004",
        command: "node /opt/homebrew/bin/codex available prompt",
        elapsedSecs: 3,
      },
    ];

    assignCodexSessionIdsByCwd(
      processes,
      [
        { id: "claimed-thread", cwd: "/tmp/repo", updated_at: 300, first_user_message: "claimed prompt" },
        { id: "available-thread", cwd: "/tmp/repo", updated_at: 200, first_user_message: "available prompt" },
      ],
      new Set(["claimed-thread"])
    );

    expect(processes[1].sessionId).toBe("available-thread");
  });

  it("allows exact prompt matches to resolve to an already claimed thread so duplicates collapse correctly", () => {
    const processes: ActiveProcess[] = [
      {
        pid: 401,
        sessionId: null,
        cwd: "/tmp/repo",
        tty: "ttys005",
        command: "node /opt/homebrew/bin/codex same prompt",
        elapsedSecs: 50,
      },
    ];

    assignCodexSessionIdsByCwd(
      processes,
      [
        { id: "claimed-thread", cwd: "/tmp/repo", updated_at: 300, first_user_message: "same prompt" },
        { id: "other-thread", cwd: "/tmp/repo", updated_at: 200, first_user_message: "other prompt" },
      ],
      new Set(["claimed-thread"])
    );

    expect(processes[0].sessionId).toBe("claimed-thread");
  });
});
