import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Fakes: one live-process table shared by the fake `spawn` and the fake liveness check ──
const SID = "51192f90-4a03-4c79-9f94-90320dc2496c";
const live = new Map<number, string>(); // pid → command
let nextPid = 1000;
const spawned: Array<{ pid: number; args: string[]; proc: EventEmitter }> = [];
const terminalLaunches: string[] = [];

vi.mock("cross-spawn", () => ({
  default: (_bin: string, args: string[]) => {
    const pid = nextPid++;
    const proc = Object.assign(new EventEmitter(), {
      pid,
      stdout: Object.assign(new EventEmitter(), { resume() {} }),
      stderr: Object.assign(new EventEmitter(), { resume() {} }),
      unref() {},
    });
    live.set(pid, `claude ${args.join(" ")}`);
    spawned.push({ pid, args, proc });
    return proc;
  },
}));

vi.mock("../session-liveness", () => ({
  findLiveSessionProcesses: (sessionId: string) =>
    [...live].filter(([, cmd]) => cmd.includes(sessionId)).map(([pid, command]) => ({ pid, command, source: "ps" })),
  killSessionAndWait: async () => ({ killed: [], survivors: [] }),
}));

const row = { project_path: "/tmp/proj", jsonl_path: "/tmp/none.jsonl", last_message: null as string | null };
const settings: Record<string, string> = { permission_check_interval_ms: "0", auto_escalate_permissions: "true" };
vi.mock("../db", () => ({
  getSetting: (k: string) => settings[k] ?? "",
  logAction: vi.fn(),
  getDb: () => ({
    prepare: () => ({
      get: () => row,
      all: () => [],
      run: () => {},
    }),
  }),
}));
vi.mock("../claude-bin", () => ({ getClaudePath: () => "claude" }));
vi.mock("../terminal-launcher", () => ({
  openInTerminal: async (cmd: string) => {
    terminalLaunches.push(cmd);
    return { terminal: "fake" };
  },
}));
vi.mock("../scanner", () => ({ scanSessions: async () => {} }));
vi.mock("../title-generator", () => ({ generateTitleBatch: async () => {} }));
vi.mock("../relay-client", () => ({ initRelayIfEnabled: () => {} }));
vi.mock("../process-detector", () => ({ killSessionProcesses: () => [], isSessionActive: () => false }));
vi.mock("../claude-runner", () => ({ createSSEStream: () => new ReadableStream(), sseResponse: () => null }));

const { getOrchestrator } = await import("../orchestrator");

const flush = () => new Promise((r) => setTimeout(r, 20));
const resumesOf = (sid: string) => spawned.filter((s) => s.args.includes(sid));

function redeployResume(sid = SID) {
  // exactly what scripts/deploy-live.js POSTs to /api/orchestrator for every "lost" session
  getOrchestrator().enqueue({ sessionId: sid, type: "resume", message: "Session Manager was redeployed…", priority: "high" });
}

describe("orchestrator: one session → at most one live process", () => {
  beforeEach(() => {
    live.clear();
    spawned.length = 0;
    terminalLaunches.length = 0;
    delete (globalThis as Record<string, unknown>).__sessionOrchestrator;
  });

  it("repeated redeploy resumes of the same session spawn only one process", async () => {
    redeployResume();
    await flush();
    redeployResume(); // second deploy / retry while the first resume is still running
    await flush();
    redeployResume();
    await flush();
    expect(resumesOf(SID)).toHaveLength(1);
  });

  it("does not resume when the original process survived the restart", async () => {
    live.set(80391, `/Users/vova/.local/bin/claude --resume ${SID} --dangerously-skip-permissions`);
    redeployResume();
    await flush();
    expect(resumesOf(SID)).toHaveLength(0);
  });

  it("allows a new resume once the previous resume process has exited", async () => {
    redeployResume();
    await flush();
    const first = resumesOf(SID)[0];
    live.delete(first.pid);
    first.proc.emit("close", 0);
    redeployResume();
    await flush();
    expect(resumesOf(SID)).toHaveLength(2);
  });

  it("claimResume is idempotent across every resume path (SSE reply included)", () => {
    const o = getOrchestrator();
    expect(o.claimResume(SID, "test")).toBe(true);
    expect(o.claimResume(SID, "test")).toBe(false);
    o.releaseResume(SID);
    live.set(1, `claude --resume ${SID}`);
    expect(o.claimResume(SID, "test")).toBe(false);
  });

  it("permission-wait escalation leaves a --dangerously-skip-permissions process alone (no terminal clone)", async () => {
    live.set(80391, `/Users/vova/.local/bin/claude --resume ${SID} --dangerously-skip-permissions`);
    // transcript looks exactly like "stuck on approval": last event is an assistant tool_use, no result
    row.jsonl_path = path.join(os.tmpdir(), `perm-wait-${Date.now()}.jsonl`);
    fs.writeFileSync(row.jsonl_path, JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash" }] } }) + "\n");
    try {
      const o = getOrchestrator() as unknown as { executePermissionWait(id: string): Promise<void> };
      await o.executePermissionWait(SID);
      expect(terminalLaunches).toHaveLength(0);

      // …while a process without skip-permissions that is gone gets exactly one terminal resume
      live.clear();
      await o.executePermissionWait(SID);
      await o.executePermissionWait(SID);
      expect(terminalLaunches).toHaveLength(1);
    } finally {
      fs.unlinkSync(row.jsonl_path);
    }
  });
});
