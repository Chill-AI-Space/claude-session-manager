"use client";

import { useState } from "react";
import type { OpencodeBuild } from "@/lib/opencode-builds";

export function OpencodeBuildSettings({ value }: { value: string }) {
  const [builds, setBuilds] = useState<OpencodeBuild[]>(() => {
    try { return JSON.parse(value || "[]"); } catch { return []; }
  });
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
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
  return <section className="space-y-3">
    <h2 className="text-sm font-semibold">OpenCode builds</h2>
    <p className="text-xs text-muted-foreground">Register completed builds here. Keep each snapshot binary at its own permanent path. Order: classic OpenCode, stable fork, then snapshots from newest to oldest. Existing sessions remember their build ID.</p>
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
    {status && <p role="status" className="text-xs">{status}</p>}
  </section>;
}
