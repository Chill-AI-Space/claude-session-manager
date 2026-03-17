"use client";

import { useState, useEffect } from "react";
import { Check, Copy } from "lucide-react";

export function RemoteRelaySettings() {
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
