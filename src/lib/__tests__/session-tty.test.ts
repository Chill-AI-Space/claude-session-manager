import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  forgetSessionTty,
  getSessionTty,
  isTtyReadyForCommand,
  rememberSessionTty,
  sessionProcessInPs,
} from "../session-tty";

afterEach(() => {
  forgetSessionTty("ses_a");
  forgetSessionTty("ses_b");
  vi.useRealTimers();
});

describe("session TTY cache", () => {
  it("remembers and returns the tty", () => {
    rememberSessionTty("ses_a", "ttys003");
    expect(getSessionTty("ses_a")).toBe("ttys003");
  });

  it("ignores empty ttys and unknown sessions", () => {
    rememberSessionTty("ses_a", null);
    rememberSessionTty("ses_a", undefined);
    expect(getSessionTty("ses_a")).toBeNull();
    expect(getSessionTty("ses_b")).toBeNull();
  });

  it("expires after 24h — a recycled tty must not be trusted forever", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
    rememberSessionTty("ses_a", "ttys003");
    expect(getSessionTty("ses_a")).toBe("ttys003");
    vi.setSystemTime(new Date("2026-10-10T12:00:01Z"));
    expect(getSessionTty("ses_a")).toBeNull();
  });

  it("forget clears it", () => {
    rememberSessionTty("ses_a", "ttys003");
    forgetSessionTty("ses_a");
    expect(getSessionTty("ses_a")).toBeNull();
  });
});

describe("isTtyReadyForCommand", () => {
  const ready = (comms: string[]) => () => comms;

  it("is ready when only a shell lives on the tty", () => {
    expect(isTtyReadyForCommand("/dev/ttys003", { listTtyComms: ready(["/usr/bin/login", "-zsh"]) })).toBe(true);
  });

  it("is not ready when an agent is attached", () => {
    expect(isTtyReadyForCommand("ttys003", { listTtyComms: ready(["-zsh", "codex"]) })).toBe(false);
    expect(isTtyReadyForCommand("ttys003", { listTtyComms: ready(["/usr/local/bin/claude"]) })).toBe(false);
    expect(isTtyReadyForCommand("ttys003", { listTtyComms: ready(["opencode"]) })).toBe(false);
  });

  it("is not ready when the window is gone (empty or ps error)", () => {
    expect(isTtyReadyForCommand("ttys003", { listTtyComms: ready([]) })).toBe(false);
    expect(
      isTtyReadyForCommand("ttys003", {
        listTtyComms: () => {
          throw new Error("ps: ttys003: No such file or directory");
        },
      })
    ).toBe(false);
  });
});

describe("sessionProcessInPs", () => {
  const codexPs = [
    "123 codex resume 01a11f61-e9a8-7853-bd73-887d4ed097f3 \"msg\"",
    "456 /bin/zsh -il",
  ].join("\n");

  it("finds a codex process bound to the session", () => {
    expect(sessionProcessInPs("01a11f61-e9a8-7853-bd73-887d4ed097f3", "codex", codexPs)).toBe(true);
  });

  it("does not match another session or the wrong agent", () => {
    expect(sessionProcessInPs("00000000-0000-0000-0000-000000000000", "codex", codexPs)).toBe(false);
    expect(sessionProcessInPs("01a11f61-e9a8-7853-bd73-887d4ed097f3", "opencode", codexPs)).toBe(false);
    expect(sessionProcessInPs("01a11f61-e9a8-7853-bd73-887d4ed097f3", "claude", codexPs)).toBe(false);
  });

  it("matches opencode by --session id", () => {
    const ps = "789 opencode --session ses_edecbe342ffeKobuntbhaHxYWa --prompt hi";
    expect(sessionProcessInPs("ses_edecbe342ffeKobuntbhaHxYWa", "opencode", ps)).toBe(true);
  });
});
