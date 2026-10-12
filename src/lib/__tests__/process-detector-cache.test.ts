import { afterEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ fail: false, empty: false }));

vi.mock("child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("child_process")>();
  return {
    ...original,
    execSync: (command: string) => command.startsWith("ps ")
      ? "123 00:10 ttys001 /usr/bin/opencode --session ses_test\n"
      : "p123\nfcwd\nn/tmp\n",
    exec: (command: string, _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
      if (command.startsWith("ps ")) {
        if (probe.fail) callback(Object.assign(new Error("ps timed out"), { code: "ETIMEDOUT" }), "");
        else if (probe.empty) callback(Object.assign(new Error("no matches"), { code: 1 }), "");
        else callback(null, "123 00:10 ttys001 /usr/bin/opencode --session ses_test\n");
      } else {
        callback(null, "p123\nfcwd\nn/tmp\n");
      }
      return {};
    },
  };
});

vi.mock("../opencode-db", () => ({
  listIndexableOpencodeSessions: () => [],
  getOpencodeFirstUserMessage: () => null,
}));
vi.mock("../codex-db", () => ({ listCodexThreads: () => [] }));

afterEach(() => {
  vi.useRealTimers();
  probe.fail = false;
  probe.empty = false;
});

describe("process detector refresh", () => {
  it("uses a fresh process scan for the first sessions-list request", async () => {
    vi.resetModules();
    const { getActiveSessionIds } = await import("../process-detector");
    expect([...getActiveSessionIds()]).toEqual(["ses_test"]);
  });

  it("keeps a live session on a transient ps error but accepts a confirmed empty scan", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { detectActiveClaudeSessions, isSessionCacheWarm } = await import("../process-detector");

    detectActiveClaudeSessions();
    expect(detectActiveClaudeSessions().map((process) => process.sessionId)).toEqual(["ses_test"]);

    probe.fail = true;
    vi.setSystemTime(9_000);
    expect(detectActiveClaudeSessions().map((process) => process.sessionId)).toEqual(["ses_test"]);
    expect(isSessionCacheWarm()).toBe(true);

    vi.setSystemTime(61_000);
    expect(detectActiveClaudeSessions()).toEqual([]);
    expect(isSessionCacheWarm()).toBe(false);

    probe.fail = false;
    probe.empty = true;
    expect(detectActiveClaudeSessions()).toEqual([]);
    expect(isSessionCacheWarm()).toBe(true);
  });
});
