import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { liveSessionIdsLocal, sessionsToResume } = require("../../../scripts/deploy-live.js");

const A = "51192f90-4a03-4c79-9f94-90320dc2496c";
const B = "a0fe993d-0000-4000-8000-000000000000";
const C = "aca8219a-0000-4000-8000-000000000000";

describe("deploy-live resume selection", () => {
  it("does not resume a session whose original process survived the restart (seen only locally, server cache cold)", () => {
    const ps = `80391 /Users/vova/.local/bin/claude --resume ${A} --dangerously-skip-permissions\n`;
    const registry = [{ pid: 4242, sessionId: B }];
    const live = liveSessionIdsLocal(ps, registry, () => true);
    const before = [A, B, C].map((sessionId) => ({ sessionId, agent: "claude" }));
    // server after-restart says nothing is alive (cold detector cache) — the local check must win
    expect(sessionsToResume(before, live).map((s: { sessionId: string }) => s.sessionId)).toEqual([C]);
  });

  it("resumes each dead session at most once even if listed twice in the snapshot", () => {
    const before = [{ sessionId: C }, { sessionId: C }];
    expect(sessionsToResume(before, new Set())).toHaveLength(1);
  });

  it("ignores dead registry pids and non-claude command lines", () => {
    const ps = `1 tail -f /x/${A}.jsonl\n2 /bin/zsh -c claude --resume ${A}\n`;
    expect([...liveSessionIdsLocal(ps, [{ pid: 9, sessionId: B }], () => false)]).toEqual([]);
  });
});
