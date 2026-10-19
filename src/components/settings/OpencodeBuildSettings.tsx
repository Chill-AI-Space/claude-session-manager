"use client";

import { useEffect, useState } from "react";
import type { OpencodeBuild } from "@/lib/opencode-builds";

interface ManagedBuildState {
  dir: string;
  current: string | null;
  previous: string | null;
  builds: Array<{ sha: string; version: string; installed: boolean; queued: boolean }>;
}

export function OpencodeBuildSettings({ value }: { value: string }) {
  const [builds, setBuilds] = useState<OpencodeBuild[]>(() => {
    try { return JSON.parse(value || "[]"); } catch { return []; }
  });
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [binary, setBinary] = useState("");
  const [busy, setBusy] = useState("");
  const [state, setState] = useState<ManagedBuildState | null>(null);
  const [managerAvailable, setManagerAvailable] = useState<boolean | null>(null);

  function reload() {
    fetch("/api/opencode/builds").then(async (r) => {
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setManagerAvailable(Boolean(data.manager?.available));
      setBuilds(JSON.parse(JSON.stringify(data.builds)) as OpencodeBuild[]);
    }).catch((e) => setStatus(String(e)));
  }

  useEffect(() => { reload(); }, []);

  function patch(index: number, changes: Partial<OpencodeBuild>) {
    setBuilds((rows) => rows.map((row, i) => i === index ? { ...row, ...changes } : row));
    setStatus("");
  }

  async function save() {
    setSaving(true);
    try {
      const response = await fetch("/api/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opencode_builds: JSON.stringify(builds) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Save failed");
      setStatus("Saved. Builds are available in the agent dropdown.");
    } catch (e) { setStatus(String(e)); }
    finally { setSaving(false); }
  }

  async function manage(action: "install" | "shift" | "rollback", payload: Record<string, string> = {}) {
    setBusy(action);
    setStatus("");
    try {
      const response = await fetch("/api/opencode/builds", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...payload }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Build manager failed");
      setState(data.state || null);
      reload();
      setStatus(data.output || `${action} done`);
    } catch (e) { setStatus(String(e)); }
    finally { setBusy(""); }
  }

  return <section className="space-y-3">
    <h2 className="text-sm font-semibold">OpenCode builds</h2>
    <p className="text-xs text-muted-foreground">Register completed builds here. Keep each snapshot binary at its own permanent path. Order: classic OpenCode, stable fork, then snapshots from newest to oldest. Existing sessions remember their build ID.</p>

    <div className="border rounded-md p-3 space-y-2">
      <h3 className="text-xs font-semibold">Install a build (last / previous)</h3>
      <p className="text-xs text-muted-foreground">
        Point this at a freshly built fork binary. The build manager copies it to
        <code className="mx-1">~/.opencode/builds/&lt;sha&gt;/opencode</code>, moves the
        <code className="mx-1">current</code> symlink to it, moves
        <code className="mx-1">previous</code> to the build that was current, and re-registers
        <code className="mx-1">OpenCode last</code> / <code className="mx-1">OpenCode previous</code> here.
        Both symlinks point at the binary file itself, so a build stays selectable until it is deleted.
      </p>
      {managerAvailable === false && <p className="text-xs text-destructive">Build manager (mem-builds.sh) not found. Set MEM_BUILDS_SCRIPT or install it at ~/.opencode/scripts/mem-builds.sh.</p>}
      <div className="flex gap-2">
        <input
          aria-label="Path to a built opencode binary"
          placeholder="/Users/you/code/opencode/packages/cli/dist/cli-darwin-arm64/bin/opencode"
          value={binary}
          onChange={(e) => setBinary(e.target.value)}
          className="flex-1 border rounded bg-background p-1 text-xs"
        />
        <button type="button" disabled={busy !== "" || !binary.trim()} onClick={() => manage("install", { binary: binary.trim() })} className="border rounded px-2 py-1 text-xs">
          {busy === "install" ? "Installing…" : "Install build"}
        </button>
        <button type="button" disabled={busy !== ""} onClick={() => manage("rollback")} className="border rounded px-2 py-1 text-xs">
          {busy === "rollback" ? "Rolling back…" : "Roll back to previous"}
        </button>
      </div>
      {state && <div className="text-xs space-y-1">
        <p><span className="text-muted-foreground">current:</span> {state.current || "(none)"} <span className="text-muted-foreground">previous:</span> {state.previous || "(none)"}</p>
        <ul className="space-y-0.5">
          {state.builds.map((b) => <li key={b.sha} className="flex gap-2 items-center">
            <code>{b.sha}</code>
            <span className="text-muted-foreground">{b.version || "(version unknown)"}</span>
            {!b.queued && <span className="text-muted-foreground">(not in queue)</span>}
            {b.sha !== state.current && <button type="button" disabled={busy !== ""} onClick={() => manage("shift", { sha: b.sha })} className="border rounded px-1">make current</button>}
          </li>)}
        </ul>
      </div>}
    </div>

    {builds.map((build, index) => <div key={index} className="border rounded-md p-3 space-y-2">
      <div className="flex gap-2">
        <input aria-label="Build ID" placeholder="Unique ID" value={build.id} onChange={(e) => patch(index, { id: e.target.value })} className="w-1/2 border rounded bg-background p-1 text-xs" />
        <select aria-label="Build kind" value={build.kind} onChange={(e) => patch(index, { kind: e.target.value as OpencodeBuild["kind"] })} className="border rounded bg-background text-xs">
          <option value="upstream">Classic OpenCode</option><option value="stable">Stable fork</option><option value="snapshot">Snapshot</option>
        </select>
        <button type="button" onClick={() => setBuilds((rows) => rows.filter((_, i) => i !== index))} className="text-xs text-destructive">Remove</button>
      </div>
      {([['name', 'Display name'], ['binary', 'Absolute path to executable'], ['builtAt', 'Build date (ISO, e.g. 2026-10-10)'], ['branch', 'Branch'], ['commit', 'Commit'], ['pullRequest', 'PR number or title'], ['description', 'Main features']] as const).map(([key, label]) => <input key={key} aria-label={label} placeholder={label} value={build[key] || ""} onChange={(e) => patch(index, { [key]: e.target.value || undefined })} className="w-full border rounded bg-background p-1 text-xs" />)}
      <label className="flex gap-2 text-xs"><input type="checkbox" checked={build.autoFlag ?? build.kind !== "upstream"} onChange={(e) => patch(index, { autoFlag: e.target.checked })} />Supports --auto (fork permission flag)</label>
    </div>)}
    <div className="flex gap-3 text-xs">
      <button type="button" onClick={() => setBuilds((rows) => [...rows, { id: `build-${Date.now()}`, name: "", binary: "", kind: "snapshot", builtAt: new Date().toISOString() }])} className="border rounded px-2 py-1">Add build</button>
      <button type="button" disabled={saving} onClick={save} className="border rounded px-2 py-1">{saving ? "Saving…" : "Save builds"}</button>
    </div>
    {status && <p role="status" className="text-xs whitespace-pre-wrap">{status}</p>}
  </section>;
}
