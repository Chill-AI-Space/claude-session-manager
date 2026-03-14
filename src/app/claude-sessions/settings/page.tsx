"use client";

import { useEffect, useState } from "react";
import { Loader2, Check, AlertCircle, Copy, X, Bell, Volume2, Monitor, CircleCheck, CircleX, Search, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { requestBrowserNotificationPermission } from "@/hooks/useNotifications";

// ── Types ────────────────────────────────────────────────────────────────────

interface Settings {
  auto_kill_terminal_on_reply: string;
  [key: string]: string | undefined;
}

interface HealthCheck {
  id: string;
  label: string;
  ok: boolean;
  required: boolean;
  fix: string | null;
}

// ── CompressOnInputSection ───────────────────────────────────────────────────

interface CompressOnInputConfig {
  imageOcr: boolean;
  jsonCollapse: boolean;
  textCompressionThreshold: number;
  ocrEngine: string;
  verbose: boolean;
}

interface CompressOnInputState {
  installed: boolean;
  hookEnabled: boolean;
  config: CompressOnInputConfig;
}

function ContextTrashSection() {
  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "installing">("loading");
  const [state, setState] = useState<CompressOnInputState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [installLog, setInstallLog] = useState("");

  function load() {
    fetch("/api/context-trash")
      .then((r) => r.json())
      .then((d) => {
        setState(d);
        setStatus(d.installed ? "ready" : "missing");
      })
      .catch(() => setStatus("missing"));
  }

  useEffect(() => { load(); }, []);

  async function handleInstall() {
    setStatus("installing");
    setInstallLog("Installing compress-on-input...\n");
    try {
      const res = await fetch("/api/context-trash/install", { method: "POST" });
      const data = await res.json();
      setInstallLog(data.log || "");
      if (data.ok) {
        setTimeout(load, 500);
      } else {
        setInstallLog((prev) => prev + "\nInstall failed. Run manually:\n  npm i -g compress-on-input && compress-on-input install");
        setStatus("missing");
      }
    } catch {
      setInstallLog("Network error. Run manually:\n  npm i -g compress-on-input && compress-on-input install");
      setStatus("missing");
    }
  }

  async function toggleHook(enabled: boolean) {
    setSaving(true);
    try {
      const res = await fetch("/api/context-trash", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hookEnabled: enabled }),
      });
      const data = await res.json();
      setState(data);
    } catch { /* ignore */ }
    finally { setSaving(false); }
  }

  function updateConfig(key: keyof CompressOnInputConfig, value: number | string | boolean) {
    if (!state) return;
    setState({ ...state, config: { ...state.config, [key]: value } });
    setDirty(true);
  }

  async function saveConfig() {
    if (!state) return;
    setSaving(true);
    try {
      const res = await fetch("/api/context-trash", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.config),
      });
      const data = await res.json();
      setState(data);
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch { /* ignore */ }
    finally { setSaving(false); }
  }

  const c = state?.config;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Compress on Input
        </h2>
        {status === "ready" && state && (
          <label className="flex items-center gap-2 cursor-pointer">
            <span className="text-xs text-muted-foreground">Hook</span>
            <input
              type="checkbox"
              checked={state.hookEnabled}
              onChange={(e) => toggleHook(e.target.checked)}
              disabled={saving}
              className="h-4 w-4 rounded border-input accent-primary"
            />
          </label>
        )}
      </div>

      {status === "loading" && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Checking compress-on-input…
        </div>
      )}

      {status === "missing" && (
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground leading-relaxed">
            <strong className="text-foreground/70">Not installed.</strong>{" "}
            Compresses tool results (screenshots → OCR, JSON → schema, DOM → cleanup) to save context window space.
          </div>
          <button
            onClick={handleInstall}
            className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:opacity-90"
          >
            Install compress-on-input
          </button>
          {installLog && (
            <pre className="text-[11px] text-muted-foreground bg-muted rounded p-2 whitespace-pre-wrap max-h-32 overflow-auto">{installLog}</pre>
          )}
        </div>
      )}

      {status === "installing" && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Installing…
          </div>
          {installLog && (
            <pre className="text-[11px] text-muted-foreground bg-muted rounded p-2 whitespace-pre-wrap max-h-32 overflow-auto">{installLog}</pre>
          )}
        </div>
      )}

      {status === "ready" && c && (
        <div className="space-y-3">
          <div className="text-xs text-muted-foreground leading-relaxed">
            Compresses tool results (screenshots → OCR, JSON → schema, DOM → cleanup) via PostToolUse hook.
            {state?.hookEnabled ? (
              <span className="ml-1 text-green-500">Active — compressing results for all tools.</span>
            ) : (
              <span className="ml-1 text-yellow-500">Disabled — toggle the hook to enable compression.</span>
            )}
          </div>

          {state?.hookEnabled && (
            <div className="border border-border rounded-md p-3 space-y-3 bg-muted/20">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Compression Settings
              </div>

              {/* Text compression threshold */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-muted-foreground">Text compression threshold</label>
                  <span className="text-xs font-mono tabular-nums text-foreground/80">
                    {(c.textCompressionThreshold / 1000).toFixed(0)}K tokens
                  </span>
                </div>
                <input
                  type="range"
                  min={10000}
                  max={200000}
                  step={10000}
                  value={c.textCompressionThreshold}
                  onChange={(e) => updateConfig("textCompressionThreshold", parseInt(e.target.value))}
                  className="w-full h-1.5 accent-primary cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-muted-foreground/50">
                  <span>10K (aggressive)</span>
                  <span>200K (only huge)</span>
                </div>
              </div>

              {/* Image OCR */}
              <div className="flex items-center justify-between">
                <label className="text-xs text-muted-foreground">Screenshot OCR (base64 → text)</label>
                <input
                  type="checkbox"
                  checked={c.imageOcr}
                  onChange={(e) => updateConfig("imageOcr", e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-input accent-primary"
                />
              </div>

              {/* JSON collapse */}
              <div className="flex items-center justify-between">
                <label className="text-xs text-muted-foreground">JSON collapse (arrays → schema)</label>
                <input
                  type="checkbox"
                  checked={c.jsonCollapse}
                  onChange={(e) => updateConfig("jsonCollapse", e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-input accent-primary"
                />
              </div>

              {/* OCR engine */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-muted-foreground">OCR engine</label>
                  <select
                    value={c.ocrEngine}
                    onChange={(e) => updateConfig("ocrEngine", e.target.value)}
                    className="text-xs px-2 py-1 rounded border border-input bg-background"
                  >
                    <option value="auto">Auto (Vision → Tesseract)</option>
                    <option value="vision">Apple Vision only</option>
                    <option value="tesseract">Tesseract only</option>
                  </select>
                </div>
              </div>

              {/* Verbose logging */}
              <div className="flex items-center justify-between">
                <label className="text-xs text-muted-foreground">Verbose logging (stderr)</label>
                <input
                  type="checkbox"
                  checked={c.verbose}
                  onChange={(e) => updateConfig("verbose", e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-input accent-primary"
                />
              </div>

              {/* Save button */}
              {dirty && (
                <div className="flex items-center gap-2 pt-1">
                  <button
                    onClick={saveConfig}
                    disabled={saving}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:opacity-90 disabled:opacity-50"
                  >
                    {saving ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : saved ? (
                      <Check className="h-3 w-3" />
                    ) : null}
                    {saved ? "Saved" : "Save"}
                  </button>
                  <span className="text-[10px] text-muted-foreground">
                    Writes to ~/.config/compress-on-input/config.json
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── HealthCheckFix ────────────────────────────────────────────────────────────

function HealthCheckFix({ fix }: { fix: string }) {
  const [copied, setCopied] = useState(false);

  // Parse "Description text: shell command" format
  const colonIdx = fix.indexOf(": ");
  let label = fix;
  let command: string | null = null;
  let isUrl = false;

  if (colonIdx !== -1) {
    const rest = fix.slice(colonIdx + 2);
    const shellPrefixes = ["brew ", "apt ", "winget ", "npm ", "pip ", "sudo ", "curl "];
    if (shellPrefixes.some((p) => rest.startsWith(p))) {
      label = fix.slice(0, colonIdx);
      command = rest;
    } else if (rest.startsWith("http://") || rest.startsWith("https://")) {
      label = fix.slice(0, colonIdx);
      command = rest;
      isUrl = true;
    }
  }

  function copy() {
    if (!command) return;
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="mt-0.5 space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      {command && (
        <div className="flex items-center gap-1.5">
          {isUrl ? (
            <a
              href={command}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-mono text-blue-500 hover:underline"
            >
              {command}
            </a>
          ) : (
            <code className="text-xs font-mono bg-muted px-2 py-0.5 rounded text-foreground">
              {command}
            </code>
          )}
          {!isUrl && (
            <button
              onClick={copy}
              className="text-muted-foreground/50 hover:text-muted-foreground transition-colors"
              title="Copy command"
            >
              {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── RemoteRelaySection ───────────────────────────────────────────────────────

function RemoteRelaySection() {
  const [relay, setRelay] = useState<{
    enabled: boolean;
    connected: boolean;
    nodeId: string | null;
    serverUrl: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [copied, setCopied] = useState(false);

  function load() {
    fetch("/api/relay")
      .then((r) => r.json())
      .then(setRelay)
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  async function toggle() {
    if (!relay) return;
    setActing(true);
    try {
      const res = await fetch("/api/relay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: relay.enabled ? "disable" : "enable" }),
      });
      const data = await res.json();
      setRelay((prev) => prev ? { ...prev, enabled: data.enabled ?? !prev.enabled, nodeId: data.nodeId ?? prev.nodeId } : prev);
      // Poll connection status after a bit
      setTimeout(load, 2000);
    } catch { /* ignore */ }
    setActing(false);
  }

  async function regenerate() {
    setActing(true);
    try {
      const res = await fetch("/api/relay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "regenerate" }),
      });
      const data = await res.json();
      setRelay((prev) => prev ? { ...prev, nodeId: data.nodeId } : prev);
    } catch { /* ignore */ }
    setActing(false);
  }

  function copyNodeId() {
    if (!relay?.nodeId) return;
    navigator.clipboard.writeText(relay.nodeId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (loading) return <div className="text-xs text-muted-foreground">Loading relay status...</div>;

  return (
    <div className="space-y-6">
      <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
        Remote Relay
      </h2>

      <div className="space-y-4">
        <div className="text-xs text-muted-foreground leading-relaxed">
          Connect this Session Manager to a relay server so you can start, resume, and stop
          sessions from anywhere — another machine, a GCP VM, or any HTTP client.
          Your Node ID is the access key.
        </div>

        <label className="flex items-start gap-3 cursor-pointer group">
          <input
            type="checkbox"
            checked={relay?.enabled ?? false}
            onChange={toggle}
            disabled={acting}
            className="mt-1 h-4 w-4 rounded border-input accent-primary"
          />
          <div className="space-y-1">
            <div className="text-sm font-medium">Enable Remote Access</div>
            <div className="text-xs text-muted-foreground leading-relaxed">
              Opens a WebSocket connection to the relay server. Remote callers
              can send commands using your Node ID.
            </div>
          </div>
        </label>

        {relay?.enabled && (
          <div className="space-y-3 pl-7">
            <div className="flex items-center gap-2">
              <div className={`h-2 w-2 rounded-full ${relay.connected ? "bg-green-500" : "bg-yellow-500 animate-pulse"}`} />
              <span className="text-xs text-muted-foreground">
                {relay.connected ? "Connected to relay" : "Connecting..."}
              </span>
            </div>

            {relay.nodeId && (
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">Node ID</div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-3 py-1.5 text-xs bg-muted rounded-md font-mono select-all break-all">
                    {relay.nodeId}
                  </code>
                  <button
                    onClick={copyNodeId}
                    className="p-1.5 rounded-md hover:bg-muted transition-colors"
                    title="Copy Node ID"
                  >
                    {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5 text-muted-foreground" />}
                  </button>
                </div>
                <div className="text-[11px] text-muted-foreground/70 leading-relaxed">
                  Share this ID with whoever needs remote access. They can send commands to:
                </div>
                <code className="block px-3 py-1.5 text-[11px] bg-muted rounded-md font-mono break-all">
                  POST {relay.serverUrl.replace("wss://", "https://").replace("/ws", "")}/node/{relay.nodeId}/resume
                </code>
              </div>
            )}

            <button
              onClick={regenerate}
              disabled={acting}
              className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
            >
              Regenerate Node ID
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── RemoteNodesSection ──────────────────────────────────────────────────────

interface RemoteNodeData {
  id: string;
  name: string;
  tailscale?: string;
  relayNodeId?: string;
  preferred: "tailscale" | "relay";
  lastSeen?: number;
  online?: boolean;
}

function RemoteNodesSection() {
  const [nodes, setNodes] = useState<RemoteNodeData[]>([]);
  const [loading, setLoading] = useState(true);
  const [pinging, setPinging] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", tailscale: "", relayNodeId: "", preferred: "tailscale" as "tailscale" | "relay" });
  const [editId, setEditId] = useState<string | null>(null);

  function load(ping = false) {
    setLoading(true);
    fetch(`/api/remote-nodes${ping ? "?ping=true" : ""}`)
      .then((r) => r.json())
      .then(setNodes)
      .catch(() => {})
      .finally(() => { setLoading(false); setPinging(false); });
  }

  useEffect(() => { load(); }, []);

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

  async function handlePing(nodeId: string) {
    try {
      const res = await fetch(`/api/remote-nodes/${nodeId}/proxy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "status" }),
      });
      const data = await res.json();
      // Refresh to get updated status
      load();
      return data.ok;
    } catch {
      return false;
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

// ── SettingsPage ──────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(100);
  const [healthChecks, setHealthChecks] = useState<HealthCheck[] | null>(null);
  const [settingsSearch, setSettingsSearch] = useState("");
  const [titleGenStatus, setTitleGenStatus] = useState<{ running: boolean; result?: string }>({ running: false });

  useEffect(() => {
    const saved = localStorage.getItem("fontSizeScale");
    if (saved) setFontSize(parseInt(saved));
  }, []);

  function applyFontSize(scale: number): void {
    setFontSize(scale);
    localStorage.setItem("fontSizeScale", scale.toString());
    document.documentElement.style.fontSize = `${(scale / 100) * 16}px`;
  }

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => setSettings(data))
      .catch(() => setError("Failed to load settings"))
      .finally(() => setLoading(false));

    fetch("/api/health")
      .then((r) => r.json())
      .then((data) => setHealthChecks(data.checks))
      .catch(() => {});
  }, []);

  async function updateSetting(key: string, value: string): Promise<void> {
    setSaving(true);
    setSavedKey(null);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      if (!res.ok) throw new Error("Save failed");
      const data = await res.json();
      setSettings(data);
      setSavedKey(key);
      setTimeout(() => setSavedKey(null), 2000);
    } catch {
      setError("Failed to save setting");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error && !settings) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-destructive gap-2">
        <AlertCircle className="h-4 w-4" />
        {error}
      </div>
    );
  }

  if (!settings) return null;

  // ── Settings search ──
  const SECTION_KEYWORDS: Record<string, string> = {
    "system-setup": "system setup health check database jsonl cli",
    "macos-permissions": "macos permissions accessibility terminal focus",
    "terminal-integration": "terminal auto kill retry crash continue stall close new session reply",
    "notifications": "notifications sound browser tab badge notify",
    "permissions": "permissions skip dangerously max turns effort thinking budget",
    "deep-search": "deep search vector pre-filter gemini",
    "folder-browser": "folder browser start path browse",
    "context-trash": "compress on input compression hook ocr screenshot json context trash",
    "remote-relay": "remote relay access websocket node uuid connect external",
    "remote-nodes": "remote nodes machines tailscale vpn server proxy fallback",
    "appearance": "appearance font size scale theme",
    "maintenance": "maintenance title generate regenerate ai titles",
  };

  function sectionVisible(id: string): boolean {
    if (!settingsSearch.trim()) return true;
    const q = settingsSearch.toLowerCase();
    const keywords = SECTION_KEYWORDS[id] || "";
    return keywords.includes(q);
  }

  const visibleCount = Object.keys(SECTION_KEYWORDS).filter(sectionVisible).length;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[600px] mx-auto px-6 py-8 space-y-8">
        <div>
          <Link
            href="/claude-sessions"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-3"
          >
            <ArrowLeft className="h-3 w-3" />
            Back to sessions
          </Link>
          <h1 className="text-lg font-semibold">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configure how Session Manager behaves when interacting with sessions.
          </p>
          <div className="relative mt-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
            <input
              type="text"
              value={settingsSearch}
              onChange={(e) => setSettingsSearch(e.target.value)}
              placeholder="Search settings…"
              className="w-full pl-9 pr-8 py-2 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {settingsSearch && (
              <button
                onClick={() => setSettingsSearch("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {visibleCount === 0 && (
          <div className="text-sm text-muted-foreground text-center py-8">
            No settings match &ldquo;{settingsSearch}&rdquo;
          </div>
        )}

        {/* ── System Setup ──────────────────────────────────────── */}
        {sectionVisible("system-setup") && healthChecks && (
          <div className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              System Setup
            </h2>
            <div className="rounded-md border border-border overflow-hidden">
              {healthChecks.map((c, i) => (
                <div
                  key={c.id}
                  className={`flex items-start gap-3 px-4 py-3 ${i > 0 ? "border-t border-border/50" : ""} ${!c.ok && c.required ? "bg-destructive/5" : ""}`}
                >
                  {c.ok ? (
                    <CircleCheck className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
                  ) : c.required ? (
                    <CircleX className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                  ) : (
                    <CircleX className="h-4 w-4 text-muted-foreground/40 shrink-0 mt-0.5" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-medium ${c.ok ? "text-foreground" : c.required ? "text-destructive" : "text-muted-foreground"}`}>
                        {c.label}
                      </span>
                      {c.required && !c.ok && (
                        <span className="text-[10px] bg-destructive/15 text-destructive px-1.5 py-0.5 rounded">required</span>
                      )}
                      {!c.required && (
                        <span className="text-[10px] text-muted-foreground/50">optional</span>
                      )}
                    </div>
                    {c.fix && <HealthCheckFix fix={c.fix} />}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {sectionVisible("maintenance") && (
          <div className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              Maintenance
            </h2>
            <div className="rounded-md border border-border p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">AI Title Generation</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Generate or regenerate titles for all sessions using Claude
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={async () => {
                      setTitleGenStatus({ running: true });
                      try {
                        const res = await fetch("/api/sessions/generate-titles", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ limit: 50 }),
                        });
                        const data = await res.json();
                        setTitleGenStatus({ running: false, result: data.error ? `Error: ${data.error}` : `Generated ${data.generated ?? 0} titles` });
                      } catch { setTitleGenStatus({ running: false, result: "Failed" }); }
                    }}
                    disabled={titleGenStatus.running}
                    className="px-3 py-1.5 text-xs rounded-md border border-border hover:bg-muted disabled:opacity-50 transition-colors"
                  >
                    {titleGenStatus.running ? <Loader2 className="h-3 w-3 animate-spin" /> : "Generate missing"}
                  </button>
                  <button
                    onClick={async () => {
                      setTitleGenStatus({ running: true });
                      try {
                        const res = await fetch("/api/sessions/generate-titles", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ limit: 50, force: true }),
                        });
                        const data = await res.json();
                        setTitleGenStatus({ running: false, result: data.error ? `Error: ${data.error}` : `Regenerated ${data.generated ?? 0} titles` });
                      } catch { setTitleGenStatus({ running: false, result: "Failed" }); }
                    }}
                    disabled={titleGenStatus.running}
                    className="px-3 py-1.5 text-xs rounded-md border border-border hover:bg-muted disabled:opacity-50 transition-colors"
                  >
                    {titleGenStatus.running ? <Loader2 className="h-3 w-3 animate-spin" /> : "Regenerate all"}
                  </button>
                </div>
              </div>
              {titleGenStatus.result && (
                <div className="text-xs text-muted-foreground">{titleGenStatus.result}</div>
              )}
            </div>
          </div>
        )}

        {sectionVisible("macos-permissions") && <div className="space-y-4">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            macOS Permissions
          </h2>
          <div className="text-xs text-muted-foreground leading-relaxed">
            <strong className="text-foreground/80">Focus Terminal</strong> requires Accessibility access so it can raise the terminal window.
            Add your terminal app below, then toggle it on.
          </div>
          <div className="border border-border rounded-md p-3 space-y-2 bg-muted/20">
            <div className="text-xs font-medium">Required: System Settings → Privacy &amp; Security → Accessibility</div>
            <div className="text-[11px] text-muted-foreground space-y-1">
              <div>• Add <strong>Terminal.app</strong> if you use the built-in terminal</div>
              <div>• Add <strong>iTerm2</strong> if you use iTerm2</div>
              <div>• <strong>node</strong> is already there — that&apos;s the server process, good to keep it</div>
            </div>
            <a
              href="x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
              className="inline-flex items-center gap-1.5 mt-1 text-[11px] text-primary underline underline-offset-2 hover:opacity-80"
            >
              Open Accessibility Settings →
            </a>
          </div>
        </div>}

        {sectionVisible("terminal-integration") && <div className="space-y-6">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Terminal Integration
          </h2>

          <label className="flex items-start gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={settings.auto_kill_terminal_on_reply === "true"}
              onChange={(e) =>
                updateSetting("auto_kill_terminal_on_reply", e.target.checked ? "true" : "false")
              }
              className="mt-1 h-4 w-4 rounded border-input accent-primary"
            />
            <div className="space-y-1">
              <div className="text-sm font-medium">
                Automatically close terminal sessions when replying from web
              </div>
              <div className="text-xs text-muted-foreground leading-relaxed">
                When you send a reply from this web interface, any running Claude
                terminal process for that session will be terminated first. This
                prevents conversation divergence between the terminal and web UI.
                If disabled, you can manually close terminal sessions using the
                button that appears after replying.
              </div>
            </div>
          </label>

          <label className="flex items-start gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={settings.auto_retry_on_crash !== "false"}
              onChange={(e) =>
                updateSetting("auto_retry_on_crash", e.target.checked ? "true" : "false")
              }
              className="mt-1 h-4 w-4 rounded border-input accent-primary"
            />
            <div className="space-y-1">
              <div className="text-sm font-medium">
                Auto-retry when Claude crashes mid-execution
              </div>
              <div className="text-xs text-muted-foreground leading-relaxed">
                When Claude dies during a tool call (e.g. Bun segfault), automatically
                resend <code className="font-mono bg-muted px-1 rounded">continue</code> after
                a 30-second countdown. You can cancel it.
              </div>
            </div>
          </label>

          <label className="flex items-start gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={settings.auto_continue_on_stall === "true"}
              onChange={(e) =>
                updateSetting("auto_continue_on_stall", e.target.checked ? "true" : "false")
              }
              className="mt-1 h-4 w-4 rounded border-input accent-primary"
            />
            <div className="space-y-1">
              <div className="text-sm font-medium">
                Auto-continue when Claude stops mid-task
              </div>
              <div className="text-xs text-muted-foreground leading-relaxed">
                When Claude is active but hasn{"'"}t responded for 5+ minutes and its last message
                doesn{"'"}t ask you a question, automatically send{" "}
                <code className="font-mono bg-muted px-1 rounded">continue</code>.
                Uses AI to detect whether Claude is waiting for your input before firing.
                Logged in the Actions Log as <em>Stall detected</em>.
              </div>
            </div>
          </label>

          <label className="flex items-start gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={settings.new_session_from_reply === "true"}
              onChange={(e) =>
                updateSetting("new_session_from_reply", e.target.checked ? "true" : "false")
              }
              className="mt-1 h-4 w-4 rounded border-input accent-primary"
            />
            <div className="space-y-1">
              <div className="text-sm font-medium">
                New session from reply panel
              </div>
              <div className="text-xs text-muted-foreground leading-relaxed">
                Show a toggle in the reply area to start a new session instead of replying.
                Choose a folder, optionally include the current session summary as context,
                and launch — all without leaving the page. Also available in{" "}
                <Link href="/claude-sessions/store" className="underline underline-offset-2 hover:text-foreground">Store</Link>.
              </div>
            </div>
          </label>
        </div>}

        {/* ── Notifications ──────────────────────────────── */}
        {sectionVisible("notifications") && <div className="space-y-4">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Notifications — when Claude finishes
          </h2>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Get notified when Claude finishes a response and is waiting for your reply.
            Works for both web and terminal sessions.
          </p>

          {/* Sound */}
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.notify_sound === "true"}
              onChange={(e) => updateSetting("notify_sound", e.target.checked ? "true" : "false")}
              className="mt-1 h-4 w-4 rounded border-input accent-primary"
            />
            <div className="space-y-0.5">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <Volume2 className="h-3.5 w-3.5 text-muted-foreground" />
                Sound
              </div>
              <div className="text-xs text-muted-foreground">
                Two-tone beep — audible even when the tab is in background
              </div>
            </div>
          </label>

          {/* Browser notification */}
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.notify_browser === "true"}
              onChange={async (e) => {
                const checked = e.target.checked; // capture before async — React resets DOM during await
                if (checked) {
                  const perm = await requestBrowserNotificationPermission();
                  if (perm !== "granted") {
                    setError("Browser notifications blocked — allow them in your browser settings first.");
                    return;
                  }
                }
                updateSetting("notify_browser", checked ? "true" : "false");
              }}
              className="mt-1 h-4 w-4 rounded border-input accent-primary"
            />
            <div className="space-y-0.5">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <Bell className="h-3.5 w-3.5 text-muted-foreground" />
                Browser notification
              </div>
              <div className="text-xs text-muted-foreground">
                System popup — visible even when the window is minimized. Requires browser permission.
              </div>
            </div>
          </label>

          {/* Tab badge */}
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.notify_tab_badge === "true"}
              onChange={(e) => updateSetting("notify_tab_badge", e.target.checked ? "true" : "false")}
              className="mt-1 h-4 w-4 rounded border-input accent-primary"
            />
            <div className="space-y-0.5">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <Monitor className="h-3.5 w-3.5 text-muted-foreground" />
                Tab title badge
              </div>
              <div className="text-xs text-muted-foreground">
                Prepends <code className="bg-muted px-1 rounded">(N) Claude is waiting</code> to the page title — visible in the browser taskbar
              </div>
            </div>
          </label>
        </div>}

        {/* ── Permissions ──────────────────────────────────── */}
        {sectionVisible("permissions") && <div className="space-y-6">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Permissions
          </h2>

          <label className="flex items-start gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={settings.dangerously_skip_permissions === "true"}
              onChange={(e) =>
                updateSetting("dangerously_skip_permissions", e.target.checked ? "true" : "false")
              }
              className="mt-1 h-4 w-4 rounded border-input accent-primary"
            />
            <div className="space-y-1">
              <div className="text-sm font-medium">
                Dangerously skip permissions
              </div>
              <div className="text-xs text-muted-foreground leading-relaxed">
                Pass <code className="px-1 py-0.5 bg-muted rounded text-[11px]">--dangerously-skip-permissions</code> when
                resuming sessions from the web interface and when opening in terminal.
                Claude will execute all tool calls without asking for confirmation.
                Use this only if you understand the risks.
              </div>
            </div>
          </label>
          <div className="space-y-2">
            <div className="text-sm font-medium">Max turns per reply</div>
            <div className="text-xs text-muted-foreground leading-relaxed mb-2">
              How many tool-use cycles Claude is allowed per single web reply.
              Each "turn" is one round of Claude calling a tool (Read, Bash, Edit, etc.) and getting the result back.
              <br /><br />
              <strong>Why this matters:</strong> Web replies use <code className="font-mono bg-muted px-1 rounded">claude -p</code> (non-interactive mode),
              which runs Claude as a one-shot process. Without enough turns, Claude may stop mid-task —
              e.g. say "I{"'"}ll write the file now" but exit before actually writing it.
              In the terminal, Claude runs interactively with unlimited turns.
              This setting bridges that gap.
              <br /><br />
              Set higher (100–200) for complex tasks. Set lower (10–20) for quick replies.
              Default: 80.
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={200}
                value={settings.max_turns || "80"}
                onChange={(e) => updateSetting("max_turns", e.target.value)}
                className="w-24 px-2 py-1.5 text-sm border border-input rounded-md bg-background"
              />
            </div>
          </div>
          <div className="space-y-2">
            <div className="text-sm font-medium">Effort level</div>
            <div className="text-xs text-muted-foreground leading-relaxed mb-2">
              Controls how much thinking Claude puts into responses.
              <strong> High</strong> = maximum effort (deeper reasoning, better results).
              <strong> Medium</strong> = faster but less thorough.
              <strong> Low</strong> = quickest, minimal thinking.
              <br /><br />
              Default: High.
            </div>
            <div className="flex items-center gap-2">
              <select
                value={settings.effort_level || "high"}
                onChange={(e) => updateSetting("effort_level", e.target.value)}
                className="px-3 py-1.5 text-sm border border-input rounded-md bg-background"
              >
                <option value="high">High (maximum)</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
          </div>
        </div>}

        {/* ── Deep Search ────────────────────────────────────
         * Keywords: deep search vector pre-filter gemini
         * To add a new section, copy this pattern:
         *   1. Add entry to SECTION_KEYWORDS above
         *   2. Wrap with: {sectionVisible("your-id") && <YourSection />}
         */}
        {sectionVisible("deep-search") && <div className="space-y-6">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Deep Search
          </h2>

          <div className="space-y-2">
            <div className="text-sm font-medium">Vector pre-filter limit</div>
            <div className="text-xs text-muted-foreground leading-relaxed mb-2">
              How many sessions the vector search narrows down before sending to
              Gemini for semantic ranking. Lower values = faster + cheaper,
              higher = more thorough. Embeddings are generated automatically.
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={5}
                max={100}
                step={5}
                value={settings.vector_search_top_k || "20"}
                onChange={(e) =>
                  setSettings({ ...settings, vector_search_top_k: e.target.value })
                }
                onBlur={(e) => {
                  const val = Math.max(5, Math.min(100, parseInt(e.target.value) || 20));
                  updateSetting("vector_search_top_k", val.toString());
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                className="w-20 px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <span className="text-xs text-muted-foreground">sessions</span>
              {savedKey === "vector_search_top_k" && (
                <span className="flex items-center gap-1 text-xs text-green-500 animate-in fade-in duration-200">
                  <Check className="h-3 w-3" />
                  Saved
                </span>
              )}
            </div>
          </div>
        </div>}

        {/* ── Folder Browser ──────────────────────────────── */}
        {sectionVisible("folder-browser") && <div className="space-y-6">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Folder Browser
          </h2>

          <div className="space-y-2">
            <div className="text-sm font-medium">Start browsing from</div>
            <div className="text-xs text-muted-foreground leading-relaxed mb-2">
              The folder tree in &quot;Start session&quot; will open at this path
              instead of the home directory. Use a path like{" "}
              <code className="px-1 py-0.5 bg-muted rounded text-[11px]">~/Documents/GitHub</code>{" "}
              to jump straight to your projects.
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={settings.browse_start_path || ""}
                onChange={(e) =>
                  setSettings({ ...settings, browse_start_path: e.target.value })
                }
                onBlur={(e) => {
                  const val = e.target.value.trim();
                  updateSetting("browse_start_path", val);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                placeholder="~ (home directory)"
                className="flex-1 px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              />
              {savedKey === "browse_start_path" && (
                <span className="flex items-center gap-1 text-xs text-green-500 animate-in fade-in duration-200">
                  <Check className="h-3 w-3" />
                  Saved
                </span>
              )}
            </div>
          </div>
        </div>}

        {/* ── Context Trash ────────────────────────────────── */}
        {sectionVisible("context-trash") && <ContextTrashSection />}

        {/* ── Remote Relay ──────────────────────────────────── */}
        {sectionVisible("remote-relay") && <RemoteRelaySection />}

        {/* ── Remote Nodes ────────────────────────────────── */}
        {sectionVisible("remote-nodes") && <RemoteNodesSection />}

        {/* ── Appearance ───────────────────────────────────── */}
        {sectionVisible("appearance") && <div className="space-y-6">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Appearance
          </h2>

          <div className="space-y-3">
            <div className="text-sm font-medium">Font size</div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground w-6 text-right">A</span>
              <input
                type="range"
                min={80}
                max={120}
                step={5}
                value={fontSize}
                onChange={(e) => applyFontSize(parseInt(e.target.value))}
                className="flex-1 accent-primary cursor-pointer"
              />
              <span className="text-base text-muted-foreground w-6">A</span>
              <span className="text-xs text-muted-foreground w-10 text-right tabular-nums">
                {fontSize}%
              </span>
              {fontSize !== 100 && (
                <button
                  onClick={() => applyFontSize(100)}
                  className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
                >
                  Reset
                </button>
              )}
            </div>
          </div>
        </div>}

        {saving && (
          <div className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" />
            Saving...
          </div>
        )}
        {error && settings && (
          <div className="text-xs text-destructive flex items-center gap-1.5">
            <AlertCircle className="h-3 w-3" />
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
