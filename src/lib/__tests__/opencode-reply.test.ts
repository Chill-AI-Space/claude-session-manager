import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({
  find: vi.fn(), tty: vi.fn(), inject: vi.fn(), open: vi.fn(), resume: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  getDb: () => ({ prepare: (sql: string) => ({
    get: () => sql.includes("SELECT * FROM sessions") ? {
      session_id: "ses_test", agent_type: "opencode", project_path: "/tmp/project",
    } : undefined,
    run: () => ({ changes: 0 }),
  }) }), getSetting: vi.fn(), logAction: vi.fn(),
}));
vi.mock("@/lib/process-detector", () => ({
  findLiveProcessForSession: deps.find, detectActiveClaudeSessions: vi.fn(), killSessionProcesses: vi.fn(),
}));
vi.mock("@/lib/macos-terminal-control", () => ({ getTTY: deps.tty, sendTextToTerminalTTYVerified: deps.inject }));
vi.mock("@/lib/terminal-launcher", () => ({ openInTerminal: deps.open }));
vi.mock("@/lib/session-terminal", () => ({ buildResumeShellCommand: deps.resume }));
vi.mock("@/lib/orchestrator", () => ({ getOrchestrator: vi.fn() }));
vi.mock("@/lib/session-pid-map", () => ({ getLiveSessionFromPidMap: vi.fn() }));
vi.mock("@/lib/session-liveness", () => ({ findLiveSessionProcesses: vi.fn() }));
vi.mock("@/lib/codex-bin", () => ({ getCodexPath: vi.fn() }));
vi.mock("@/lib/codex-command", () => ({ buildCodexResumeShellCommand: vi.fn() }));
vi.mock("@/lib/claude-runner", () => ({ sseResponse: vi.fn(), SSE_HEADERS: { "Content-Type": "text/event-stream" } }));
vi.mock("@/lib/remote-compute", () => ({ resolveNode: vi.fn(), proxySSE: vi.fn() }));

import { POST } from "@/app/api/sessions/[sessionId]/reply/route";

async function reply() {
  const response = await POST(new NextRequest("http://localhost/api/sessions/ses_test/reply", {
    method: "POST", body: JSON.stringify({ message: "continue" }),
  }), { params: Promise.resolve({ sessionId: "ses_test" }) });
  return response.text();
}

describe("OpenCode reply", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    deps.find.mockReturnValue({ pid: 123 });
    deps.tty.mockReturnValue("ttys001");
    deps.inject.mockResolvedValue({ ok: true, terminal: "iTerm2" });
    deps.open.mockResolvedValue({ terminal: "iTerm2" });
    deps.resume.mockReturnValue("opencode --session ses_test");
  });
  it("delivers to the existing TUI without opening another process", async () => {
    expect(await reply()).toContain("OpenCode reply sent");
    expect(deps.inject).toHaveBeenCalledOnce();
    expect(deps.open).not.toHaveBeenCalled();
  });
  it("reports injection failure without opening a clone", async () => {
    deps.inject.mockResolvedValue({ ok: false, reason: "verification_failed" });
    expect(await reply()).toContain("a duplicate was not started");
    expect(deps.open).not.toHaveBeenCalled();
  });
  it("reports a live headless process without opening a clone", async () => {
    deps.tty.mockReturnValue(null);
    expect(await reply()).toContain("a duplicate was not started");
    expect(deps.open).not.toHaveBeenCalled();
    expect(deps.inject).not.toHaveBeenCalled();
  });
  it("does not spawn when fresh process detection fails", async () => {
    deps.find.mockImplementation(() => { throw new Error("process scan failed"); });
    expect(await reply()).toContain("process scan failed");
    expect(deps.open).not.toHaveBeenCalled();
  });
  it("opens a terminal when the session has no live process", async () => {
    deps.find.mockReturnValue(null);
    expect(await reply()).toContain("Opencode resumed");
    expect(deps.open).toHaveBeenCalledOnce();
    expect(deps.inject).not.toHaveBeenCalled();
  });
});
