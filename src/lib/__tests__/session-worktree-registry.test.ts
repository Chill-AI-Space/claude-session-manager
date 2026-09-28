import { beforeEach, describe, expect, it, vi } from "vitest";

const { runCalls } = vi.hoisted(() => ({ runCalls: [] as unknown[][] }));

vi.mock("../db", () => ({
  getDb: () => ({
    prepare: () => ({
      run: (...args: unknown[]) => {
        runCalls.push(args);
        return { changes: 1 };
      },
    }),
  }),
  logAction: vi.fn(),
}));
vi.mock("../process-detector", () => ({ getActiveSessionIds: () => new Set<string>() }));
vi.mock("../orchestrator", () => ({ getOrchestrator: () => ({ getAllStates: () => [] }) }));

import { withWorktreeStatus } from "../session-worktree-registry";

const enc = new TextEncoder();
const dec = new TextDecoder();

function sse(...events: Record<string, unknown>[]): Uint8Array {
  return enc.encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
}

function readAll(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  return (async () => {
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    return out;
  })();
}

beforeEach(() => {
  runCalls.length = 0;
});

describe("withWorktreeStatus", () => {
  const record = { sourcePath: "/src/repo", branch: "session/task-1" };

  it("prepends the status event and passes source chunks through", async () => {
    const inner = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(sse({ type: "session_id", session_id: "ses_abc" }, { type: "done" }));
        c.close();
      },
    });
    const wrapped = withWorktreeStatus(inner, "Worktree: /wt (branch session/task-1)", record);
    const out = await readAll(wrapped.getReader());
    expect(out).toContain("Worktree: /wt");
    expect(out).toContain('"session_id":"ses_abc"');
    expect(out).toContain('"type":"done"');
    expect(runCalls).toEqual([["/src/repo", "session/task-1", "ses_abc"]]);
  });

  // Regression: cancel() used to call stream.cancel() on the very stream
  // start() had locked with getReader() → TypeError "ReadableStream is
  // locked" → Next logs "failed to pipe response" on every client disconnect
  // and the worktree row never gets worktree_source_path/worktree_branch.
  it("cancel() before session_id does not throw, still records, then releases the source", async () => {
    let innerCtl: ReadableStreamDefaultController<Uint8Array> | undefined;
    let sourceCancelled = false;
    const inner = new ReadableStream<Uint8Array>({
      start(c) {
        innerCtl = c;
        c.enqueue(sse({ type: "status", text: "opening" }));
      },
      cancel() {
        sourceCancelled = true;
      },
    });
    const wrapped = withWorktreeStatus(inner, "Worktree: /wt (branch session/task-1)", record);
    const reader = wrapped.getReader();

    const first = await reader.read();
    expect(dec.decode(first.value)).toContain("Worktree: /wt");

    await expect(reader.cancel()).resolves.toBeUndefined();
    // Record still pending → the source must stay alive for the drain loop.
    expect(sourceCancelled).toBe(false);

    // session_id arrives after the client is gone.
    innerCtl!.enqueue(sse({ type: "session_id", session_id: "ses_after_cancel" }));

    await vi.waitFor(() => expect(runCalls).toHaveLength(1));
    expect(runCalls[0]).toEqual(["/src/repo", "session/task-1", "ses_after_cancel"]);
    // Recorded → wrapper releases the source instead of leaking it.
    await vi.waitFor(() => expect(sourceCancelled).toBe(true));
  });

  it("cancel() with no record releases the source right away", async () => {
    let sourceCancelled = false;
    const inner = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(sse({ type: "status", text: "skipped" }));
        // never emits session_id — e.g. worktree creation was skipped
      },
      cancel() {
        sourceCancelled = true;
      },
    });
    const wrapped = withWorktreeStatus(inner, "Worktree skipped (not a git repository) — running in /src");
    const reader = wrapped.getReader();
    await reader.read();
    await expect(reader.cancel()).resolves.toBeUndefined();
    await vi.waitFor(() => expect(sourceCancelled).toBe(true));
    expect(runCalls).toHaveLength(0);
  });

  it("cancel() after session_id releases the source immediately", async () => {
    let sourceCancelled = false;
    const inner = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(sse({ type: "session_id", session_id: "ses_y" }));
        // stays open — more output may follow
      },
      cancel() {
        sourceCancelled = true;
      },
    });
    const wrapped = withWorktreeStatus(inner, "Worktree: /wt", record);
    const reader = wrapped.getReader();
    const first = await reader.read(); // wrapper's own status event
    expect(dec.decode(first.value)).toContain("Worktree: /wt");
    const second = await reader.read();
    expect(dec.decode(second.value)).toContain("session_id");

    await expect(reader.cancel()).resolves.toBeUndefined();
    await vi.waitFor(() => expect(sourceCancelled).toBe(true));
    expect(runCalls).toHaveLength(1);
  });

  it("records session_id even when it straddles chunk boundaries after disconnect", async () => {
    let innerCtl: ReadableStreamDefaultController<Uint8Array> | undefined;
    let sourceCancelled = false;
    const inner = new ReadableStream<Uint8Array>({
      start(c) {
        innerCtl = c;
      },
      cancel() {
        sourceCancelled = true;
      },
    });
    const wrapped = withWorktreeStatus(inner, "Worktree: /wt", record);
    const reader = wrapped.getReader();
    await reader.read(); // status
    await reader.cancel(); // client walked away before any source data

    innerCtl!.enqueue(enc.encode('data: {"type":"status","text":"x"}\n\ndata: {"type":"sess'));
    innerCtl!.enqueue(enc.encode('ion_id","session_id":"ses_split"}\n\n'));

    await vi.waitFor(() => expect(runCalls).toHaveLength(1));
    expect(runCalls[0][2]).toBe("ses_split");
    await vi.waitFor(() => expect(sourceCancelled).toBe(true));
  });
});
