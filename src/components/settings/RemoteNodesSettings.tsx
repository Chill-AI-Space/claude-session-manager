"use client";

import { useState, useEffect } from "react";

interface RemoteNodeData {
  id: string;
  name: string;
  tailscale?: string;
  relayNodeId?: string;
  preferred: "tailscale" | "relay";
  lastSeen?: number;
  online?: boolean;
}

export function RemoteNodesSettings() {
  const [nodes, setNodes] = useState<RemoteNodeData[]>([]);
  const [loading, setLoading] = useState(true);
  const [pinging, setPinging] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", tailscale: "", relayNodeId: "", preferred: "tailscale" as "tailscale" | "relay" });
  const [editId, setEditId] = useState<string | null>(null);
  const [defaultComputeNode, setDefaultComputeNode] = useState<string>("");

  function load(ping = false) {
    setLoading(true);
    fetch(`/api/remote-nodes${ping ? "?ping=true" : ""}`)
      .then((r) => r.json())
      .then(setNodes)
      .catch(() => {})
      .finally(() => { setLoading(false); setPinging(false); });
  }

  useEffect(() => {
    load();
    // Load default compute node setting
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => setDefaultComputeNode(s.default_compute_node || ""))
      .catch(() => {});
  }, []);

  async function handleAdd() {
    if (!form.name || (!form.tailscale && !form.relayNodeId)) return;
    setAdding(true);
    try {
      await fetch("/api/remote-nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      setForm({ name: "", tailscale: "", relayNodeId: "", preferred: "tailscale" });
      load();
    } catch { /* ignore */ }
    setAdding(false);
  }

  async function handleDelete(id: string) {
    await fetch(`/api/remote-nodes?id=${id}`, { method: "DELETE" });
    load();
  }

  async function handleUpdate(id: string, updates: Partial<RemoteNodeData>) {
    await fetch("/api/remote-nodes", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...updates }),
    });
    setEditId(null);
    load();
  }

  async function handleSetComputeNode(nodeId: string) {
    setDefaultComputeNode(nodeId);
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default_compute_node: nodeId }),
    });
  }

  async function handlePing(nodeId: string) {
    try {
      await fetch(`/api/remote-nodes/${nodeId}/proxy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "status" }),
      });
      load();
    } catch {
      // ignore
    }
  }

  function formatLastSeen(ts?: number) {
    if (!ts) return "never";
    const diff = Date.now() - ts;
    if (diff < 60_000) return "just now";
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
    return `${Math.floor(diff / 86400_000)}d ago`;
  }

  return (
    <div className="space-y-6">
      <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
        Remote Nodes
      </h2>

      <div className="text-xs text-muted-foreground leading-relaxed">
        Register other machines running Session Manager. Commands are sent via
        Tailscale (direct P2P) or Cloudflare Relay (via internet), with automatic fallback.
      </div>

      {/* Default Compute Node selector */}
      {nodes.length > 0 && (
        <div className="border border-border rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-medium">Default Compute Node</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                New sessions will run on this remote VM instead of locally
              </div>
            </div>
            <select
              value={defaultComputeNode}
              onChange={(e) => handleSetComputeNode(e.target.value)}
              className="px-2 py-1 text-xs bg-muted rounded border border-border min-w-[160px]"
            >
              <option value="">Local (this machine)</option>
              {nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name} {n.online ? "" : "(offline)"}
                </option>
              ))}
            </select>
          </div>
          {defaultComputeNode && (
            <div className="flex items-center gap-1.5 text-[11px]">
              <div className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
              <span className="text-blue-400">
                Remote compute active — sessions run on {nodes.find(n => n.id === defaultComputeNode)?.name || "remote VM"}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Node list */}
      {nodes.length > 0 && (
        <div className="space-y-2">
          {nodes.map((node) => (
            <div key={node.id} className="border border-border rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={`h-2 w-2 rounded-full ${node.online ? "bg-green-500" : "bg-zinc-400"}`} />
                  <span className="text-sm font-medium">{node.name}</span>
                  <span className="text-[11px] text-muted-foreground">
                    ({node.preferred === "tailscale" ? "Tailscale primary" : "Relay primary"})
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground">
                    {formatLastSeen(node.lastSeen)}
                  </span>
                  <button
                    onClick={() => handlePing(node.id)}
                    className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2"
                  >
                    ping
                  </button>
                  <button
                    onClick={() => setEditId(editId === node.id ? null : node.id)}
                    className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2"
                  >
                    edit
                  </button>
                  <button
                    onClick={() => handleDelete(node.id)}
                    className="text-[11px] text-red-400 hover:text-red-300 underline underline-offset-2"
                  >
                    remove
                  </button>
                </div>
              </div>

              {/* Connection details */}
              <div className="flex gap-4 text-[11px] text-muted-foreground">
                {node.tailscale && <span>Tailscale: <code className="bg-muted px-1 rounded">{node.tailscale}</code></span>}
                {node.relayNodeId && <span>Relay: <code className="bg-muted px-1 rounded">{node.relayNodeId.slice(0, 8)}...</code></span>}
              </div>

              {/* Edit form */}
              {editId === node.id && (
                <div className="border-t border-border pt-2 space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      className="px-2 py-1 text-xs bg-muted rounded border border-border"
                      placeholder="Tailscale address"
                      defaultValue={node.tailscale || ""}
                      onBlur={(e) => handleUpdate(node.id, { tailscale: e.target.value || undefined })}
                    />
                    <input
                      className="px-2 py-1 text-xs bg-muted rounded border border-border"
                      placeholder="Relay Node ID"
                      defaultValue={node.relayNodeId || ""}
                      onBlur={(e) => handleUpdate(node.id, { relayNodeId: e.target.value || undefined })}
                    />
                  </div>
                  <div className="flex gap-2">
                    <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                      <input
                        type="radio"
                        name={`preferred-${node.id}`}
                        checked={node.preferred === "tailscale"}
                        onChange={() => handleUpdate(node.id, { preferred: "tailscale" })}
                        className="accent-primary"
                      />
                      Tailscale first
                    </label>
                    <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                      <input
                        type="radio"
                        name={`preferred-${node.id}`}
                        checked={node.preferred === "relay"}
                        onChange={() => handleUpdate(node.id, { preferred: "relay" })}
                        className="accent-primary"
                      />
                      Relay first
                    </label>
                  </div>
                </div>
              )}
            </div>
          ))}

          <button
            onClick={() => { setPinging(true); load(true); }}
            disabled={pinging}
            className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
          >
            {pinging ? "Pinging all..." : "Ping all nodes"}
          </button>
        </div>
      )}

      {/* Add node form */}
      <div className="border border-dashed border-border rounded-lg p-3 space-y-3">
        <div className="text-xs font-medium">Add Remote Node</div>
        <div className="grid grid-cols-2 gap-2">
          <input
            className="px-2 py-1.5 text-xs bg-muted rounded border border-border col-span-2"
            placeholder="Name (e.g. home-server)"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
          <input
            className="px-2 py-1.5 text-xs bg-muted rounded border border-border"
            placeholder="Tailscale: server.tailnet.ts.net:3000"
            value={form.tailscale}
            onChange={(e) => setForm((f) => ({ ...f, tailscale: e.target.value }))}
          />
          <input
            className="px-2 py-1.5 text-xs bg-muted rounded border border-border"
            placeholder="Relay Node ID (UUID)"
            value={form.relayNodeId}
            onChange={(e) => setForm((f) => ({ ...f, relayNodeId: e.target.value }))}
          />
        </div>
        <div className="flex items-center justify-between">
          <div className="flex gap-3">
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input
                type="radio"
                name="new-preferred"
                checked={form.preferred === "tailscale"}
                onChange={() => setForm((f) => ({ ...f, preferred: "tailscale" }))}
                className="accent-primary"
              />
              Tailscale first
            </label>
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input
                type="radio"
                name="new-preferred"
                checked={form.preferred === "relay"}
                onChange={() => setForm((f) => ({ ...f, preferred: "relay" }))}
                className="accent-primary"
              />
              Relay first
            </label>
          </div>
          <button
            onClick={handleAdd}
            disabled={adding || !form.name || (!form.tailscale && !form.relayNodeId)}
            className="px-3 py-1 text-xs bg-primary text-primary-foreground rounded-md hover:opacity-90 disabled:opacity-40"
          >
            {adding ? "Adding..." : "Add Node"}
          </button>
        </div>
      </div>

      {/* Usage hint */}
      {nodes.length > 0 && (
        <div className="text-[11px] text-muted-foreground/70 leading-relaxed space-y-1">
          <div>Send commands to remote nodes via API:</div>
          <code className="block px-2 py-1 bg-muted rounded text-[11px] font-mono">
            POST /api/remote-nodes/{'<nodeId>'}/proxy {'{"action":"start","projectPath":"/path","message":"fix bug"}'}
          </code>
        </div>
      )}
    </div>
  );
}
