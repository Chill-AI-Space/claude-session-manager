import { describe, expect, it } from "vitest";

import {
  assignCodexSessionIdsByCwd,
  assignOpencodeSessionIdsByCwd,
  extractCodexCdPath,
  isOpencodeCommand,
  isOpencodeSessionCommand,
  type ActiveProcess,
} from "../process-detector";

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

describe("isOpencodeCommand", () => {
  it("matches the OpenCode CLI on argv[0]", () => {
    expect(isOpencodeCommand("/Users/x/.opencode/bin/opencode --auto --prompt hello")).toBe(true);
    expect(isOpencodeCommand("opencode run -s ses_abc123 message")).toBe(true);
  });

  it("does not match other commands merely mentioning opencode", () => {
    expect(isOpencodeCommand("claude --dangerously-skip-permissions use opencode")).toBe(false);
    expect(isOpencodeCommand("grep -rn opencode src")).toBe(false);
    expect(isOpencodeCommand("vim notes/opencode")).toBe(false);
    expect(isOpencodeCommand("")).toBe(false);
  });
});

describe("isOpencodeSessionCommand", () => {
  it("accepts TUI, run, and attached sessions", () => {
    expect(isOpencodeSessionCommand("/Users/x/.opencode/bin/opencode --auto --prompt hello")).toBe(true);
    expect(isOpencodeSessionCommand("opencode run -s ses_abc123 message")).toBe(true);
    expect(isOpencodeSessionCommand("opencode --session ses_abc123")).toBe(true);
  });

  it("does not treat multi-session servers as a single live agent", () => {
    expect(isOpencodeSessionCommand("opencode serve --pure --port 34128")).toBe(false);
    expect(isOpencodeSessionCommand("opencode web --port 4096")).toBe(false);
    expect(isOpencodeSessionCommand("opencode acp")).toBe(false);
    expect(isOpencodeSessionCommand("opencode mcp")).toBe(false);
  });
});

describe("assignOpencodeSessionIdsByCwd", () => {
  const opencodeProc = (overrides: Partial<ActiveProcess> = {}): ActiveProcess => ({
    pid: 501,
    sessionId: null,
    cwd: "/tmp/repo",
    tty: "ttys010",
    command: "/Users/x/.opencode/bin/opencode --auto --prompt Привет мир",
    elapsedSecs: 40,
    ...overrides,
  });

  it("does not assign a server process to a nearby user session", () => {
    const processes = [opencodeProc({ command: "/Users/x/.opencode/bin/opencode serve --pure --port 34128" })];
    assignOpencodeSessionIdsByCwd(
      processes,
      [{ id: "user-session", directory: "/tmp/repo", time_created: 100, time_updated: 200 }],
      new Set(),
    );
    expect(processes[0].sessionId).toBeNull();
  });

  it("binds a fresh --prompt process to the session with the same first prompt", () => {
    const processes = [opencodeProc()];

    assignOpencodeSessionIdsByCwd(
      processes,
      [
        { id: "other-session", directory: "/tmp/repo", time_created: 100, time_updated: 900, first_user_message: "что-то другое" },
        { id: "target-session", directory: "/tmp/repo", time_created: 200, time_updated: 800, first_user_message: "Привет мир" },
      ],
      new Set()
    );

    expect(processes[0].sessionId).toBe("target-session");
  });

  it("resolves prompts lazily via firstPromptOf when candidates carry none", () => {
    const processes = [opencodeProc({ command: "/Users/x/.opencode/bin/opencode --auto --prompt lazy prompt" })];

    assignOpencodeSessionIdsByCwd(
      processes,
      [{ id: "lazy-session", directory: "/tmp/repo", time_created: 100, time_updated: 200 }],
      new Set(),
      { firstPromptOf: (id) => (id === "lazy-session" ? "lazy prompt" : null) }
    );

    expect(processes[0].sessionId).toBe("lazy-session");
  });

  it("undoes ps \\012 newline escapes before matching prompts", () => {
    const processes = [opencodeProc({ command: "/Users/x/.opencode/bin/opencode --auto --prompt line one\\012line two" })];

    assignOpencodeSessionIdsByCwd(
      processes,
      [
        {
          id: "multiline-session",
          directory: "/tmp/repo",
          time_created: 100,
          time_updated: 200,
          first_user_message: "line one\nline two",
        },
      ],
      new Set()
    );

    expect(processes[0].sessionId).toBe("multiline-session");
  });

  it("falls back to the session whose start is nearest the process start", () => {
    const processes = [opencodeProc({ command: "/Users/x/.opencode/bin/opencode --auto", elapsedSecs: 100 })];

    assignOpencodeSessionIdsByCwd(
      processes,
      [
        { id: "old-session", directory: "/tmp/repo", time_created: 100_000, time_updated: 150_000, first_user_message: "old" },
        { id: "near-session", directory: "/tmp/repo", time_created: 899_000, time_updated: 910_000, first_user_message: "near" },
      ],
      new Set(),
      { now: () => 1_000_000 }
    );

    expect(processes[0].sessionId).toBe("near-session");
  });

  it("never assigns an already claimed session in the time-based fallback", () => {
    const processes = [opencodeProc({ command: "/Users/x/.opencode/bin/opencode --auto", elapsedSecs: 100 })];

    assignOpencodeSessionIdsByCwd(
      processes,
      [{ id: "claimed-session", directory: "/tmp/repo", time_created: 900_000, time_updated: 910_000, first_user_message: "claimed" }],
      new Set(["claimed-session"]),
      { now: () => 1_000_000 }
    );

    expect(processes[0].sessionId).toBeNull();
  });

  it("keeps parent and child processes of one prompt on the same session", () => {
    const processes = [
      opencodeProc({ pid: 501, elapsedSecs: 40 }),
      opencodeProc({ pid: 502, elapsedSecs: 39 }),
    ];

    assignOpencodeSessionIdsByCwd(
      processes,
      [{ id: "one-session", directory: "/tmp/repo", time_created: 100, time_updated: 200, first_user_message: "Привет мир" }],
      new Set()
    );

    expect(processes[0].sessionId).toBe("one-session");
    expect(processes[1].sessionId).toBe("one-session");
  });

  it("ignores processes of other agents", () => {
    const processes = [opencodeProc({ command: "node /opt/homebrew/bin/codex Привет мир" })];

    assignOpencodeSessionIdsByCwd(
      processes,
      [{ id: "some-session", directory: "/tmp/repo", time_created: 100, time_updated: 200, first_user_message: "Привет мир" }],
      new Set()
    );

    expect(processes[0].sessionId).toBeNull();
  });
});

describe("extractCodexCdPath", () => {
  it("reads the project path from -C regardless of the OS cwd", () => {
    expect(
      extractCodexCdPath("codex -C /Users/vova/code/trained-agent-architecture --dangerously-bypass-approvals-and-sandbox")
    ).toBe("/Users/vova/code/trained-agent-architecture");
  });

  it("supports --cd and --cd= forms, including under a node wrapper", () => {
    expect(extractCodexCdPath("node /opt/homebrew/bin/codex --cd /repo/x -p hi")).toBe("/repo/x");
    expect(extractCodexCdPath("codex --cd=/repo/y exec task")).toBe("/repo/y");
  });

  it("returns null without -C, for non-codex commands, or when the flag has no value", () => {
    expect(extractCodexCdPath("codex --dangerously-bypass-approvals-and-sandbox")).toBeNull();
    expect(extractCodexCdPath("claude --resume abc")).toBeNull();
    expect(extractCodexCdPath("codex -C --model gpt")).toBeNull();
  });
});
