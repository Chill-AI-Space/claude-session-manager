"use client";

import { useEffect, useState } from "react";
import { Loader2, Check, AlertCircle, Trash2, Plus, RefreshCw, Copy, ExternalLink, Github, Globe, FolderOpen, ChevronDown, ChevronRight, Power, X, Bell, Volume2, Monitor, CircleCheck, CircleX, Search, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { requestBrowserNotificationPermission } from "@/hooks/useNotifications";

// ── Types ────────────────────────────────────────────────────────────────────

interface GDriveAccount {
  id: string;
  name: string;
  type: "service_account" | "oauth";
  key_path?: string;
  refresh_token?: string;
  client_id?: string;
  client_secret?: string;
}

interface Settings {
  auto_kill_terminal_on_reply: string;
  gdrive_accounts?: string;
  [key: string]: string | undefined;
}

interface HealthCheck {
  id: string;
  label: string;
  ok: boolean;
  required: boolean;
  fix: string | null;
}

// ── useGDriveOAuth hook ──────────────────────────────────────────────────────

interface GDriveOAuthState {
  authUrl: string | null;
  starting: boolean;
  copied: boolean;
}

function useGDriveOAuth(onComplete: () => void, onError: (msg: string) => void) {
  const [oauth, setOAuth] = useState<GDriveOAuthState>({
    authUrl: null,
    starting: false,
    copied: false,
  });

  function reset(): void {
    setOAuth({ authUrl: null, starting: false, copied: false });
  }

  function copyUrl(): void {
    if (!oauth.authUrl) return;
    navigator.clipboard.writeText(oauth.authUrl);
    setOAuth((prev) => ({ ...prev, copied: true }));
    setTimeout(() => setOAuth((prev) => ({ ...prev, copied: false })), 2000);
  }

  async function start(credentials: { name: string; client_id: string; client_secret: string }): Promise<void> {
    setOAuth((prev) => ({ ...prev, starting: true }));
    try {
      const res = await fetch("/api/gdrive/oauth-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentials),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setOAuth((prev) => ({ ...prev, authUrl: data.authUrl }));
      pollStatus(data.state);
    } catch (e) {
      onError(String(e));
    } finally {
      setOAuth((prev) => ({ ...prev, starting: false }));
    }
  }

  function pollStatus(state: string): void {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/gdrive/oauth-status?state=${state}`);
        const data = await res.json();
        if (data.done) {
          clearInterval(interval);
          reset();
          onComplete();
        }
      } catch { /* ignore */ }
    }, 2000);
    setTimeout(() => clearInterval(interval), 5 * 60 * 1000);
  }

  return { ...oauth, start, reset, copyUrl };
}

// ── TeamHubSection ────────────────────────────────────────────────────────────

interface HubSearchSettings {
  bm25_keep_ratio: number;
  gemini_input_tokens: number;
  gemini_output_tokens: number;
  top_k: number;
}

interface HubInfo {
  path: string;
  team: string[];
  search: HubSearchSettings;
}

function TeamHubSection({ enabled, onToggle }: { enabled: boolean; onToggle: (v: boolean) => void }) {
  const [status, setStatus] = useState<"loading" | "available" | "missing">("loading");
  const [hubs, setHubs] = useState<Record<string, HubInfo>>({});
  const [expandedHub, setExpandedHub] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  function loadStatus() {
    fetch("/api/teamhub/status")
      .then((r) => r.json())
      .then((d) => {
        setStatus(d.available ? "available" : "missing");
        setHubs(d.hubs ?? {});
      })
      .catch(() => setStatus("missing"));
  }

  useEffect(() => { loadStatus(); }, []);

  async function updateSearch(hubName: string, key: keyof HubSearchSettings, value: number) {
    // Optimistic update
    setHubs((prev) => ({
      ...prev,
      [hubName]: {
        ...prev[hubName],
        search: { ...prev[hubName].search, [key]: value },
      },
    }));
  }

  async function saveHubSearch(hubName: string) {
    setSaving(hubName);
    try {
      const res = await fetch("/api/teamhub/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hubName, search: hubs[hubName].search }),
      });
      const data = await res.json();
      if (data.ok && data.hubs) setHubs(data.hubs);
      setSaved(hubName);
      setTimeout(() => setSaved(null), 2000);
    } catch { /* ignore */ }
    finally { setSaving(null); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          TeamHub — Context Injection
        </h2>
        {status === "available" && (
          <label className="flex items-center gap-2 cursor-pointer">
            <span className="text-xs text-muted-foreground">Auto-inject</span>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => onToggle(e.target.checked)}
              className="h-4 w-4 rounded border-input accent-primary"
            />
          </label>
        )}
      </div>

      {status === "loading" && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Checking TeamHub…
        </div>
      )}

      {status === "missing" && (
        <div className="text-xs text-muted-foreground leading-relaxed">
          <strong className="text-foreground/70">TeamHub not configured.</strong>{" "}
          Install and set up TeamHub to automatically inject shared team knowledge into sessions.{" "}
          <code className="px-1 py-0.5 bg-muted rounded text-[11px]">npm i -g teamhub && teamhub init ~/team-hub --name my-team</code>
        </div>
      )}

      {status === "available" && (
        <div className="space-y-3">
          <div className="text-xs text-muted-foreground leading-relaxed">
            When enabled, relevant context from connected hubs is automatically prepended to replies sent from the web UI.
            Each injection is logged in the{" "}
            <a href="/claude-sessions/actions" className="underline underline-offset-2">Actions log</a>.
          </div>
          {Object.keys(hubs).length > 0 && (
            <div className="border border-border rounded-md divide-y divide-border">
              {Object.entries(hubs).map(([name, hub]) => {
                const isExpanded = expandedHub === name;
                const s = hub.search;
                return (
                  <div key={name}>
                    <button
                      onClick={() => setExpandedHub(isExpanded ? null : name)}
                      className="w-full flex items-center gap-3 px-3 py-2 hover:bg-accent/30 transition-colors"
                    >
                      <div className="h-2 w-2 rounded-full bg-green-500 shrink-0" />
                      <div className="flex-1 min-w-0 text-left">
                        <div className="text-sm font-medium">{name}</div>
                        <div className="text-xs text-muted-foreground truncate">
                          {hub.path}
                          {hub.team.length > 0 && (
                            <span className="ml-2 opacity-60">· {hub.team.join(", ")}</span>
                          )}
                        </div>
                      </div>
                      {isExpanded ? (
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      )}
                    </button>

                    {isExpanded && (
                      <div className="px-3 pb-3 pt-1 space-y-3 border-t border-border/50 bg-muted/20">
                        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide pt-1">
                          Search Pipeline
                        </div>

                        {/* BM25 keep ratio */}
                        <div className="space-y-1">
                          <div className="flex items-center justify-between">
                            <label className="text-xs text-muted-foreground">BM25 keep ratio</label>
                            <span className="text-xs font-mono tabular-nums text-foreground/80">
                              {Math.round(s.bm25_keep_ratio * 100)}%
                            </span>
                          </div>
                          <input
                            type="range"
                            min={0.05}
                            max={1}
                            step={0.05}
                            value={s.bm25_keep_ratio}
                            onChange={(e) => updateSearch(name, "bm25_keep_ratio", parseFloat(e.target.value))}
                            className="w-full h-1.5 accent-primary cursor-pointer"
                          />
                          <div className="flex justify-between text-[10px] text-muted-foreground/50">
                            <span>5% (strict)</span>
                            <span>100% (all docs)</span>
                          </div>
                        </div>

                        {/* Gemini input tokens */}
                        <div className="space-y-1">
                          <div className="flex items-center justify-between">
                            <label className="text-xs text-muted-foreground">Gemini input tokens</label>
                            <span className="text-xs font-mono tabular-nums text-foreground/80">
                              {s.gemini_input_tokens.toLocaleString()}
                            </span>
                          </div>
                          <input
                            type="range"
                            min={10000}
                            max={500000}
                            step={10000}
                            value={s.gemini_input_tokens}
                            onChange={(e) => updateSearch(name, "gemini_input_tokens", parseInt(e.target.value))}
                            className="w-full h-1.5 accent-primary cursor-pointer"
                          />
                          <div className="flex justify-between text-[10px] text-muted-foreground/50">
                            <span>10K</span>
                            <span>500K</span>
                          </div>
                        </div>

                        {/* Gemini output tokens */}
                        <div className="space-y-1">
                          <div className="flex items-center justify-between">
                            <label className="text-xs text-muted-foreground">Gemini output tokens</label>
                            <span className="text-xs font-mono tabular-nums text-foreground/80">
                              {s.gemini_output_tokens.toLocaleString()}
                            </span>
                          </div>
                          <input
                            type="range"
                            min={500}
                            max={8000}
                            step={500}
                            value={s.gemini_output_tokens}
                            onChange={(e) => updateSearch(name, "gemini_output_tokens", parseInt(e.target.value))}
                            className="w-full h-1.5 accent-primary cursor-pointer"
                          />
                          <div className="flex justify-between text-[10px] text-muted-foreground/50">
                            <span>500</span>
                            <span>8K</span>
                          </div>
                        </div>

                        {/* Top K */}
                        <div className="space-y-1">
                          <div className="flex items-center justify-between">
                            <label className="text-xs text-muted-foreground">Top K documents</label>
                            <span className="text-xs font-mono tabular-nums text-foreground/80">
                              {s.top_k}
                            </span>
                          </div>
                          <input
                            type="range"
                            min={1}
                            max={10}
                            step={1}
                            value={s.top_k}
                            onChange={(e) => updateSearch(name, "top_k", parseInt(e.target.value))}
                            className="w-full h-1.5 accent-primary cursor-pointer"
                          />
                          <div className="flex justify-between text-[10px] text-muted-foreground/50">
                            <span>1 doc</span>
                            <span>10 docs</span>
                          </div>
                        </div>

                        {/* Save button */}
                        <div className="flex items-center gap-2 pt-1">
                          <button
                            onClick={() => saveHubSearch(name)}
                            disabled={saving === name}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:opacity-90 disabled:opacity-50"
                          >
                            {saving === name ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : saved === name ? (
                              <Check className="h-3 w-3" />
                            ) : null}
                            {saved === name ? "Saved" : "Save"}
                          </button>
                          <span className="text-[10px] text-muted-foreground">
                            Writes to ~/.teamhub/config.yaml
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
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

// ── ContextSaverSection ───────────────────────────────────────────────────────

interface ContextSaverConfig {
  contextThresholdPercent: number;
  maxContextTokens: number;
  minChunkSizeChars: number;
  chunkSelectionPercent: number;
  skipLastNMessages: number;
  relevanceWeights: number[];
  targetCompressionRatio: number;
  geminiModel: string;
  geminiApiKey: string;
  maxConcurrentCompressions: number;
  cooldownMinutes: number;
  backupEnabled: boolean;
}

interface ContextSaverLog {
  sessionId: string;
  timestamp: string;
  contextBefore: { tokens: number; percent: number };
  contextAfter: { estimatedTokens: number; estimatedPercent: number };
  totalReductionPercent: string;
  chunksProcessed: number;
  chunks: { lineIndex: number; type: string; role: string; originalSize: number; compressedSize: number; reductionPercent: string }[];
}

interface ContextSaverState {
  installed: boolean;
  hookEnabled: boolean;
  config: ContextSaverConfig;
  recentLogs: ContextSaverLog[];
}

function ContextSaverSection() {
  const [status, setStatus] = useState<"loading" | "ready" | "missing">("loading");
  const [state, setState] = useState<ContextSaverState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [logsExpanded, setLogsExpanded] = useState(false);

  function load() {
    fetch("/api/compact-by-parts")
      .then((r) => r.json())
      .then((d) => {
        setState(d);
        setStatus(d.installed ? "ready" : "missing");
      })
      .catch(() => setStatus("missing"));
  }

  useEffect(() => { load(); }, []);

  async function toggleHook(enabled: boolean) {
    setSaving(true);
    try {
      const res = await fetch("/api/compact-by-parts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hookEnabled: enabled }),
      });
      const data = await res.json();
      setState(data);
    } catch { /* ignore */ }
    finally { setSaving(false); }
  }

  function updateConfig(key: keyof ContextSaverConfig, value: number | string | boolean | number[]) {
    if (!state) return;
    setState({ ...state, config: { ...state.config, [key]: value } });
    setDirty(true);
  }

  async function saveConfig() {
    if (!state) return;
    setSaving(true);
    try {
      const res = await fetch("/api/compact-by-parts", {
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
  const logs = state?.recentLogs ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Compact by Parts — Pre-Compact Hook
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
          Checking Compact by Parts…
        </div>
      )}

      {status === "missing" && (
        <div className="space-y-3">
          <div className="text-xs text-muted-foreground leading-relaxed">
            <strong className="text-foreground/70">Compact by Parts not installed.</strong>{" "}
            Compresses old conversation history chunk-by-chunk via Gemini before Claude&apos;s built-in compact destroys it.
            Unlike Claude&apos;s built-in compact (which summarizes everything at once), this tool preserves information
            relevant to your recent questions.
          </div>
          <div className="border border-border rounded-md p-3 space-y-2 bg-muted/20">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Installation</div>
            <div className="space-y-1.5 text-xs text-muted-foreground">
              <div className="flex items-start gap-2">
                <span className="text-foreground/50 font-mono w-4 shrink-0">1.</span>
                <div>
                  <span>Clone the repo:</span>
                  <code className="ml-1 px-1.5 py-0.5 bg-muted rounded text-[11px] break-all">
                    git clone https://github.com/Chill-AI-Space/compact-by-parts ~/Documents/GitHub/compact-by-parts
                  </code>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-foreground/50 font-mono w-4 shrink-0">2.</span>
                <div>
                  <span>Set up Gemini API key:</span>
                  <code className="ml-1 px-1.5 py-0.5 bg-muted rounded text-[11px]">
                    ~/Documents/GitHub/compact-by-parts/bin/cbp set-key YOUR_KEY
                  </code>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-foreground/50 font-mono w-4 shrink-0">3.</span>
                <div>
                  <span>Run installer (registers hook, sets up wrapper, verifies):</span>
                  <code className="ml-1 px-1.5 py-0.5 bg-muted rounded text-[11px]">
                    ~/Documents/GitHub/compact-by-parts/bin/cbp install && source ~/.zshrc
                  </code>
                </div>
              </div>
            </div>
            <div className="text-[10px] text-muted-foreground/60 pt-1 border-t border-border/50">
              Requires: Node.js 22+, Claude Code CLI, Gemini API key (free from aistudio.google.com/apikey).
            </div>
          </div>
        </div>
      )}

      {status === "ready" && c && (
        <div className="space-y-3">
          <div className="text-xs text-muted-foreground leading-relaxed">
            Intercepts on UserPromptSubmit. When context exceeds the threshold, compresses fat old messages
            via Gemini Flash with weighted relevance to your recent questions.
            {state?.hookEnabled ? (
              <span className="ml-1 text-green-500">Active — monitoring context usage.</span>
            ) : (
              <span className="ml-1 text-yellow-500">Disabled — toggle the hook to enable compression.</span>
            )}
          </div>

          {state?.hookEnabled && (
            <div className="border border-border rounded-md p-3 space-y-3 bg-muted/20">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Compression Settings
              </div>

              {/* Trigger threshold */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-muted-foreground">Trigger threshold</label>
                  <span className="text-xs font-mono tabular-nums text-foreground/80">
                    {c.contextThresholdPercent}% (~{Math.round(c.maxContextTokens * c.contextThresholdPercent / 100 / 1000)}K tokens)
                  </span>
                </div>
                <input
                  type="range"
                  min={30}
                  max={90}
                  step={5}
                  value={c.contextThresholdPercent}
                  onChange={(e) => updateConfig("contextThresholdPercent", parseInt(e.target.value))}
                  className="w-full h-1.5 accent-primary cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-muted-foreground/50">
                  <span>30% (early)</span>
                  <span>90% (last resort)</span>
                </div>
              </div>

              {/* Chunk selection percent */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-muted-foreground">Chunk selection (by cumulative size)</label>
                  <span className="text-xs font-mono tabular-nums text-foreground/80">
                    top {c.chunkSelectionPercent}%
                  </span>
                </div>
                <input
                  type="range"
                  min={50}
                  max={100}
                  step={5}
                  value={c.chunkSelectionPercent}
                  onChange={(e) => updateConfig("chunkSelectionPercent", parseInt(e.target.value))}
                  className="w-full h-1.5 accent-primary cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-muted-foreground/50">
                  <span>50% (only biggest)</span>
                  <span>100% (compress all)</span>
                </div>
              </div>

              {/* Min chunk size */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-muted-foreground">Min chunk size (absolute floor)</label>
                  <span className="text-xs font-mono tabular-nums text-foreground/80">
                    {c.minChunkSizeChars >= 1000 ? `${(c.minChunkSizeChars / 1000).toFixed(0)}KB` : `${c.minChunkSizeChars} chars`}
                  </span>
                </div>
                <input
                  type="range"
                  min={500}
                  max={50000}
                  step={500}
                  value={c.minChunkSizeChars}
                  onChange={(e) => updateConfig("minChunkSizeChars", parseInt(e.target.value))}
                  className="w-full h-1.5 accent-primary cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-muted-foreground/50">
                  <span>500 chars</span>
                  <span>50KB</span>
                </div>
              </div>

              {/* Target compression ratio */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-muted-foreground">Target compression ratio</label>
                  <span className="text-xs font-mono tabular-nums text-foreground/80">
                    {Math.round(c.targetCompressionRatio * 100)}% of original
                  </span>
                </div>
                <input
                  type="range"
                  min={5}
                  max={50}
                  step={5}
                  value={Math.round(c.targetCompressionRatio * 100)}
                  onChange={(e) => updateConfig("targetCompressionRatio", parseInt(e.target.value) / 100)}
                  className="w-full h-1.5 accent-primary cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-muted-foreground/50">
                  <span>5% (very aggressive)</span>
                  <span>50% (preserve more)</span>
                </div>
              </div>

              {/* Skip last N messages */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-muted-foreground">Protect last N messages</label>
                  <span className="text-xs font-mono tabular-nums text-foreground/80">
                    {c.skipLastNMessages}
                  </span>
                </div>
                <input
                  type="range"
                  min={2}
                  max={20}
                  step={1}
                  value={c.skipLastNMessages}
                  onChange={(e) => updateConfig("skipLastNMessages", parseInt(e.target.value))}
                  className="w-full h-1.5 accent-primary cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-muted-foreground/50">
                  <span>2 (compress more)</span>
                  <span>20 (keep recent)</span>
                </div>
              </div>

              {/* Max context tokens */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-muted-foreground">Max context window</label>
                  <span className="text-xs font-mono tabular-nums text-foreground/80">
                    {(c.maxContextTokens / 1000).toFixed(0)}K tokens
                  </span>
                </div>
                <input
                  type="range"
                  min={100000}
                  max={300000}
                  step={10000}
                  value={c.maxContextTokens}
                  onChange={(e) => updateConfig("maxContextTokens", parseInt(e.target.value))}
                  className="w-full h-1.5 accent-primary cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-muted-foreground/50">
                  <span>100K</span>
                  <span>300K</span>
                </div>
              </div>

              {/* Gemini model */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-muted-foreground">Gemini model</label>
                  <select
                    value={c.geminiModel}
                    onChange={(e) => updateConfig("geminiModel", e.target.value)}
                    className="text-xs px-2 py-1 rounded border border-input bg-background"
                  >
                    <option value="gemini-2.0-flash">gemini-2.0-flash</option>
                    <option value="gemini-2.5-flash">gemini-2.5-flash</option>
                    <option value="gemini-2.0-flash-lite">gemini-2.0-flash-lite</option>
                  </select>
                </div>
              </div>

              {/* Concurrent compressions */}
              <div className="flex items-center justify-between">
                <label className="text-xs text-muted-foreground">Max concurrent compressions</label>
                <select
                  value={c.maxConcurrentCompressions}
                  onChange={(e) => updateConfig("maxConcurrentCompressions", parseInt(e.target.value))}
                  className="text-xs px-2 py-1 rounded border border-input bg-background"
                >
                  {[1, 3, 5, 10, 20, 30].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>

              {/* Cooldown */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-muted-foreground">Cooldown after compression</label>
                  <span className="text-xs font-mono tabular-nums text-foreground/80">
                    {c.cooldownMinutes} min
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={10}
                  step={1}
                  value={c.cooldownMinutes}
                  onChange={(e) => updateConfig("cooldownMinutes", parseInt(e.target.value))}
                  className="w-full h-1.5 accent-primary cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-muted-foreground/50">
                  <span>0 (no cooldown)</span>
                  <span>10 min</span>
                </div>
              </div>

              {/* Gemini API key */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-muted-foreground">Gemini API key</label>
                  <span className="text-[10px] text-muted-foreground/50">
                    {c.geminiApiKey ? "configured" : "not set"}
                  </span>
                </div>
                <input
                  type="password"
                  placeholder={c.geminiApiKey || "paste key from aistudio.google.com/apikey"}
                  onChange={(e) => {
                    if (e.target.value && !e.target.value.startsWith("***")) {
                      updateConfig("geminiApiKey", e.target.value);
                    }
                  }}
                  className="w-full text-xs px-2 py-1.5 rounded border border-input bg-background placeholder:text-muted-foreground/40"
                />
              </div>

              {/* Backup enabled */}
              <div className="flex items-center justify-between">
                <label className="text-xs text-muted-foreground">Backup JSONL before compression</label>
                <input
                  type="checkbox"
                  checked={c.backupEnabled}
                  onChange={(e) => updateConfig("backupEnabled", e.target.checked)}
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
                    Writes to ~/.config/compact-by-parts/config.json
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Recent compression logs */}
          {logs.length > 0 && (
            <div className="space-y-2">
              <button
                onClick={() => setLogsExpanded(!logsExpanded)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {logsExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                Recent compressions ({logs.length})
              </button>
              {logsExpanded && (
                <div className="border border-border rounded-md divide-y divide-border text-xs">
                  {logs.map((log, i) => (
                    <div key={i} className="px-3 py-2 space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-muted-foreground">{log.sessionId.slice(0, 8)}...</span>
                        <span className="text-muted-foreground/70">{new Date(log.timestamp).toLocaleString()}</span>
                      </div>
                      <div className="flex items-center gap-3 text-muted-foreground">
                        <span>{log.contextBefore.percent.toFixed(0)}% → ~{log.contextAfter.estimatedPercent.toFixed(0)}%</span>
                        <span>{log.chunksProcessed} chunks</span>
                        <span className="text-green-500">-{log.totalReductionPercent}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── GDriveAccountsSection ────────────────────────────────────────────────────

interface GDriveAccountsSectionProps {
  accounts: GDriveAccount[];
  savedKey: string | null;
  onSave: (accounts: GDriveAccount[]) => Promise<void>;
  onError: (msg: string) => void;
  onReloadAccounts: () => Promise<void>;
}

function GDriveAccountsSection({ accounts, savedKey, onSave, onError, onReloadAccounts }: GDriveAccountsSectionProps) {
  const [showAddSA, setShowAddSA] = useState(false);
  const [showAddOAuth, setShowAddOAuth] = useState(false);
  const [newSA, setNewSA] = useState({ name: "", key_path: "" });
  const [newOAuth, setNewOAuth] = useState({ name: "", client_id: "", client_secret: "" });
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; error?: string }>>({});

  const oauth = useGDriveOAuth(
    async () => {
      await onReloadAccounts();
      setShowAddOAuth(false);
      setNewOAuth({ name: "", client_id: "", client_secret: "" });
    },
    onError
  );

  async function addServiceAccount(): Promise<void> {
    if (!newSA.name.trim() || !newSA.key_path.trim()) return;
    const account: GDriveAccount = {
      id: crypto.randomUUID(),
      type: "service_account",
      name: newSA.name.trim(),
      key_path: newSA.key_path.trim(),
    };
    await onSave([...accounts, account]);
    setNewSA({ name: "", key_path: "" });
    setShowAddSA(false);
  }

  async function startOAuth(): Promise<void> {
    if (!newOAuth.name.trim() || !newOAuth.client_id.trim() || !newOAuth.client_secret.trim()) return;
    await oauth.start(newOAuth);
  }

  function cancelOAuth(): void {
    setShowAddOAuth(false);
    oauth.reset();
  }

  async function testConnection(accountId: string): Promise<void> {
    setTestingId(accountId);
    try {
      const res = await fetch("/api/gdrive/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      const data = await res.json();
      setTestResults((prev) => ({ ...prev, [accountId]: data }));
    } catch (e) {
      setTestResults((prev) => ({ ...prev, [accountId]: { ok: false, error: String(e) } }));
    } finally {
      setTestingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Google Drive Accounts
        </h2>
        {savedKey === "gdrive_accounts" && (
          <span className="flex items-center gap-1 text-xs text-green-500">
            <Check className="h-3 w-3" /> Saved
          </span>
        )}
      </div>

      <div className="text-xs text-muted-foreground leading-relaxed">
        Connect Google Drive accounts to browse Drive files in the Files tab.
        Supports service accounts (for Workspace) and OAuth (personal accounts).
      </div>

      {accounts.length > 0 && (
        <div className="border border-border rounded-md divide-y divide-border">
          {accounts.map((acc) => (
            <div key={acc.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{acc.name}</div>
                <div className="text-xs text-muted-foreground">
                  {acc.type === "service_account" ? "Service Account" : "OAuth"}{" "}
                  {acc.key_path && <span className="opacity-60">· {acc.key_path}</span>}
                </div>
                {testResults[acc.id] && (
                  <div className={`text-xs mt-0.5 ${testResults[acc.id].ok ? "text-green-500" : "text-destructive"}`}>
                    {testResults[acc.id].ok ? "Connected" : `${testResults[acc.id].error}`}
                  </div>
                )}
              </div>
              <button
                onClick={() => testConnection(acc.id)}
                disabled={testingId === acc.id}
                className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                title="Test connection"
              >
                {testingId === acc.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              </button>
              <button
                onClick={() => onSave(accounts.filter((a) => a.id !== acc.id))}
                className="text-muted-foreground hover:text-destructive"
                title="Remove account"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {showAddSA && (
        <div className="border border-border rounded-md p-4 space-y-3">
          <div className="text-sm font-medium">Add Service Account</div>
          <input
            type="text"
            placeholder="Name (e.g. Work Drive)"
            value={newSA.name}
            onChange={(e) => setNewSA({ ...newSA, name: e.target.value })}
            className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <input
            type="text"
            placeholder="Path to JSON key file (e.g. ~/.config/service-account.json)"
            value={newSA.key_path}
            onChange={(e) => setNewSA({ ...newSA, key_path: e.target.value })}
            className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <div className="flex gap-2">
            <button
              onClick={addServiceAccount}
              className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:opacity-90"
            >
              Save
            </button>
            <button
              onClick={() => setShowAddSA(false)}
              className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {showAddOAuth && (
        <div className="border border-border rounded-md p-4 space-y-3">
          <div className="text-sm font-medium">Add Google Account (OAuth)</div>
          <div className="text-xs text-muted-foreground leading-relaxed">
            Create OAuth credentials in{" "}
            <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer" className="underline underline-offset-2">
              Google Cloud Console
            </a>{" "}
            with redirect URI{" "}
            <code className="px-1 py-0.5 bg-muted rounded text-[11px]">http://localhost:3000/api/gdrive/oauth-callback</code>
          </div>

          {!oauth.authUrl ? (
            <>
              <input
                type="text"
                placeholder="Name (e.g. Personal Drive)"
                value={newOAuth.name}
                onChange={(e) => setNewOAuth({ ...newOAuth, name: e.target.value })}
                className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <input
                type="text"
                placeholder="Client ID"
                value={newOAuth.client_id}
                onChange={(e) => setNewOAuth({ ...newOAuth, client_id: e.target.value })}
                className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <input
                type="password"
                placeholder="Client Secret"
                value={newOAuth.client_secret}
                onChange={(e) => setNewOAuth({ ...newOAuth, client_secret: e.target.value })}
                className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <div className="flex gap-2">
                <button
                  onClick={startOAuth}
                  disabled={oauth.starting || !newOAuth.name.trim() || !newOAuth.client_id.trim() || !newOAuth.client_secret.trim()}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:opacity-90 disabled:opacity-50"
                >
                  {oauth.starting ? <Loader2 className="h-3 w-3 animate-spin" /> : <ExternalLink className="h-3 w-3" />}
                  Authorize
                </button>
                <button
                  onClick={cancelOAuth}
                  className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="text-xs text-muted-foreground">
                Open this URL in the browser where you&apos;re signed into Google, then authorize access.
                This page will update automatically.
              </div>

              <div className="bg-muted/40 rounded-md p-3 flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-mono break-all text-foreground/70">{oauth.authUrl}</p>
                </div>
              </div>

              <div className="flex gap-2 flex-wrap">
                <a
                  href={oauth.authUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:opacity-90"
                >
                  <ExternalLink className="h-3 w-3" />
                  Open in this browser
                </a>
                <button
                  onClick={oauth.copyUrl}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-border rounded-md hover:bg-accent/50 transition-colors"
                >
                  {oauth.copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                  {oauth.copied ? "Copied!" : "Copy URL"}
                </button>
                <button
                  onClick={cancelOAuth}
                  className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
              </div>

              <div className="flex items-center gap-1.5 text-xs text-muted-foreground/60">
                <Loader2 className="h-3 w-3 animate-spin" />
                Waiting for authorization...
              </div>
            </>
          )}
        </div>
      )}

      {!showAddSA && !showAddOAuth && (
        <div className="flex gap-2">
          <button
            onClick={() => { setShowAddSA(true); setShowAddOAuth(false); }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-border rounded-md hover:bg-accent/50 transition-colors"
          >
            <Plus className="h-3 w-3" />
            Add Service Account
          </button>
          <button
            onClick={() => { setShowAddOAuth(true); setShowAddSA(false); }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-border rounded-md hover:bg-accent/50 transition-colors"
          >
            <Plus className="h-3 w-3" />
            Add OAuth Account
          </button>
        </div>
      )}
    </div>
  );
}

// ── Context Sources ───────────────────────────────────────────────────────────

interface CtxSource {
  id: string;
  type: "github" | "url" | "local";
  label: string;
  config: Record<string, string>;
}

interface CtxGroup {
  id: string;
  name: string;
  enabled: boolean;
  sources: CtxSource[];
  patterns: string[];
}

const EMPTY_GROUP = (): CtxGroup => ({
  id: crypto.randomUUID(),
  name: "",
  enabled: true,
  sources: [],
  patterns: [],
});

function ContextSourcesSection() {
  const [groups, setGroups] = useState<CtxGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CtxGroup | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/context-sources")
      .then((r) => r.json())
      .then((data) => setGroups(data))
      .finally(() => setLoading(false));
  }, []);

  function openEdit(group: CtxGroup): void {
    setDraft({ ...group, sources: group.sources.map((s) => ({ ...s })), patterns: [...group.patterns] });
    setEditingId(group.id);
  }

  function openNew(): void {
    const g = EMPTY_GROUP();
    setDraft(g);
    setEditingId(g.id);
  }

  async function saveGroup(): Promise<void> {
    if (!draft) return;
    setSaving(true);
    try {
      await fetch("/api/context-sources", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      setGroups((prev) => {
        const idx = prev.findIndex((g) => g.id === draft.id);
        if (idx >= 0) { const next = [...prev]; next[idx] = draft; return next; }
        return [...prev, draft];
      });
      setEditingId(null);
      setDraft(null);
    } finally {
      setSaving(false);
    }
  }

  async function deleteGroup(id: string): Promise<void> {
    await fetch(`/api/context-sources?id=${id}`, { method: "DELETE" });
    setGroups((prev) => prev.filter((g) => g.id !== id));
    if (editingId === id) { setEditingId(null); setDraft(null); }
  }

  async function toggleGroup(id: string): Promise<void> {
    const g = groups.find((g) => g.id === id);
    if (!g) return;
    const updated = { ...g, enabled: !g.enabled };
    await fetch("/api/context-sources", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated),
    });
    setGroups((prev) => prev.map((x) => (x.id === id ? updated : x)));
  }

  // ── Draft editor helpers ──

  function addSource(type: CtxSource["type"]): void {
    if (!draft) return;
    setDraft({ ...draft, sources: [...draft.sources, { id: crypto.randomUUID(), type, label: "", config: {} }] });
  }

  function updateSource(id: string, field: string, value: string): void {
    if (!draft) return;
    setDraft({
      ...draft,
      sources: draft.sources.map((s) => {
        if (s.id !== id) return s;
        if (field === "label") return { ...s, label: value };
        return { ...s, config: { ...s.config, [field]: value } };
      }),
    });
  }

  function removeSource(id: string): void {
    if (!draft) return;
    setDraft({ ...draft, sources: draft.sources.filter((s) => s.id !== id) });
  }

  function addPattern(): void {
    if (!draft) return;
    setDraft({ ...draft, patterns: [...draft.patterns, ""] });
  }

  function updatePattern(idx: number, value: string): void {
    if (!draft) return;
    const next = [...draft.patterns];
    next[idx] = value;
    setDraft({ ...draft, patterns: next });
  }

  function removePattern(idx: number): void {
    if (!draft) return;
    setDraft({ ...draft, patterns: draft.patterns.filter((_, i) => i !== idx) });
  }

  const sourceIcon = { github: <Github className="h-3.5 w-3.5" />, url: <Globe className="h-3.5 w-3.5" />, local: <FolderOpen className="h-3.5 w-3.5" /> };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Context Sources</h2>
      </div>

      <div className="text-xs text-muted-foreground leading-relaxed space-y-1">
        <p>Attach external knowledge to specific project folders. Content is fetched and prepended to every reply you send from the web UI.</p>
        <p className="text-muted-foreground/60">
          ⚠ URLs are fetched as a plain web scraper — sites like LinkedIn or Notion won&apos;t work without a token.
          Private GitHub repos require a PAT. Content is cached 5 minutes.
        </p>
      </div>

      {loading && <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />Loading…</div>}

      {!loading && groups.length === 0 && editingId === null && (
        <div className="text-xs text-muted-foreground italic">No source groups yet. Create one to get started.</div>
      )}

      {/* Group list */}
      {groups.map((g) => (
        <div key={g.id} className={`border rounded-md ${g.enabled ? "border-border" : "border-border/40 opacity-60"}`}>
          <div className="flex items-center gap-2 px-3 py-2.5">
            <button
              onClick={() => toggleGroup(g.id)}
              title={g.enabled ? "Disable" : "Enable"}
              className={`shrink-0 ${g.enabled ? "text-green-500" : "text-muted-foreground/40"} hover:opacity-80`}
            >
              <Power className="h-3.5 w-3.5" />
            </button>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{g.name}</div>
              <div className="text-xs text-muted-foreground truncate">
                {g.sources.length} source{g.sources.length !== 1 ? "s" : ""} ·{" "}
                {g.patterns.length === 0 ? "all projects" : g.patterns.filter(Boolean).join(", ")}
              </div>
            </div>
            <button
              onClick={() => openEdit(g)}
              className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
            >
              Edit
            </button>
            <button onClick={() => deleteGroup(g.id)} className="text-muted-foreground hover:text-destructive">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ))}

      {/* Inline editor / creator */}
      {draft && editingId && (
        <div className="border border-primary/40 rounded-md p-4 space-y-4 bg-muted/10">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">{groups.find((g) => g.id === editingId) ? "Edit group" : "New source group"}</div>
            <button onClick={() => { setEditingId(null); setDraft(null); }} className="text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Name */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Group name</label>
            <input
              type="text"
              placeholder="e.g. API Docs, Team Standards"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          {/* Sources */}
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground font-medium">Sources</div>

            {draft.sources.map((s) => (
              <div key={s.id} className="border border-border/60 rounded-md p-3 space-y-2 bg-background">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">{sourceIcon[s.type]}</span>
                  <span className="text-xs font-medium capitalize">{s.type}</span>
                  <input
                    type="text"
                    placeholder="Label (optional)"
                    value={s.label}
                    onChange={(e) => updateSource(s.id, "label", e.target.value)}
                    className="flex-1 px-2 py-1 text-xs rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  <button onClick={() => removeSource(s.id)} className="text-muted-foreground hover:text-destructive">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>

                {s.type === "github" && (
                  <div className="space-y-1.5">
                    <input
                      type="text"
                      placeholder="Repo URL (e.g. https://github.com/org/repo)"
                      value={s.config.repo ?? ""}
                      onChange={(e) => updateSource(s.id, "repo", e.target.value)}
                      className="w-full px-2 py-1 text-xs rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                    <div className="flex gap-2">
                      <input
                        type="text"
                        placeholder="Branch (default: HEAD)"
                        value={s.config.branch ?? ""}
                        onChange={(e) => updateSource(s.id, "branch", e.target.value)}
                        className="flex-1 px-2 py-1 text-xs rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                      <input
                        type="text"
                        placeholder="Path (e.g. docs/README.md)"
                        value={s.config.path ?? ""}
                        onChange={(e) => updateSource(s.id, "path", e.target.value)}
                        className="flex-1 px-2 py-1 text-xs rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                    </div>
                    <input
                      type="password"
                      placeholder="GitHub PAT (required for private repos)"
                      value={s.config.pat ?? ""}
                      onChange={(e) => updateSource(s.id, "pat", e.target.value)}
                      className="w-full px-2 py-1 text-xs rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                    <div className="text-[11px] text-muted-foreground/60">
                      Without a PAT, only public repos work. Generate one at github.com/settings/tokens (scope: contents:read).
                    </div>
                  </div>
                )}

                {s.type === "url" && (
                  <div className="space-y-1.5">
                    <input
                      type="url"
                      placeholder="https://docs.example.com/api"
                      value={s.config.url ?? ""}
                      onChange={(e) => updateSource(s.id, "url", e.target.value)}
                      className="w-full px-2 py-1 text-xs rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                    <div className="text-[11px] text-muted-foreground/60">
                      Fetched as a plain HTTP request. Works for public documentation pages.
                      Sites requiring login (Notion, LinkedIn, Confluence) are not supported.
                    </div>
                  </div>
                )}

                {s.type === "local" && (
                  <div className="space-y-1.5">
                    <input
                      type="text"
                      placeholder="/path/to/context.md or ~/Documents/notes.txt"
                      value={s.config.localPath ?? ""}
                      onChange={(e) => updateSource(s.id, "localPath", e.target.value)}
                      className="w-full px-2 py-1 text-xs rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                    <div className="text-[11px] text-muted-foreground/60">
                      Reads a local text file from disk. Great for team standards, architecture notes, or shared context documents.
                    </div>
                  </div>
                )}
              </div>
            ))}

            <div className="flex gap-2">
              <button
                onClick={() => addSource("github")}
                className="flex items-center gap-1 px-2.5 py-1.5 text-xs border border-border rounded-md hover:bg-accent/50 transition-colors"
              >
                <Github className="h-3 w-3" /> GitHub
              </button>
              <button
                onClick={() => addSource("url")}
                className="flex items-center gap-1 px-2.5 py-1.5 text-xs border border-border rounded-md hover:bg-accent/50 transition-colors"
              >
                <Globe className="h-3 w-3" /> URL
              </button>
              <button
                onClick={() => addSource("local")}
                className="flex items-center gap-1 px-2.5 py-1.5 text-xs border border-border rounded-md hover:bg-accent/50 transition-colors"
              >
                <FolderOpen className="h-3 w-3" /> Local file
              </button>
            </div>
          </div>

          {/* Folder patterns */}
          <div className="space-y-2">
            <div className="space-y-0.5">
              <div className="text-xs text-muted-foreground font-medium">Apply to folders</div>
              <div className="text-[11px] text-muted-foreground/60">
                Leave empty to inject for ALL projects. Add paths or prefixes to limit scope.
                Use <code className="px-0.5 bg-muted rounded">*</code> for all, or{" "}
                <code className="px-0.5 bg-muted rounded">~/Documents/GitHub/my-project</code> for a specific folder.
              </div>
            </div>

            {draft.patterns.map((p, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="~/Documents/GitHub/project-name"
                  value={p}
                  onChange={(e) => updatePattern(i, e.target.value)}
                  className="flex-1 px-2 py-1 text-xs rounded border border-input bg-background font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <button onClick={() => removePattern(i)} className="text-muted-foreground hover:text-destructive">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}

            <button
              onClick={addPattern}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs border border-dashed border-border rounded-md hover:bg-accent/50 transition-colors text-muted-foreground"
            >
              <Plus className="h-3 w-3" /> Add folder
            </button>
          </div>

          {/* Save / cancel */}
          <div className="flex gap-2 pt-1">
            <button
              onClick={saveGroup}
              disabled={saving || !draft.name.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:opacity-90 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              Save group
            </button>
            <button
              onClick={() => { setEditingId(null); setDraft(null); }}
              className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {editingId === null && (
        <button
          onClick={openNew}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-dashed border-border rounded-md hover:bg-accent/50 transition-colors text-muted-foreground"
        >
          <Plus className="h-3 w-3" /> New source group
        </button>
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

// ── SettingsPage ──────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(100);
  const [gdAccounts, setGdAccounts] = useState<GDriveAccount[]>([]);
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
      .then((data) => {
        setSettings(data);
        if (data.gdrive_accounts) {
          try { setGdAccounts(JSON.parse(data.gdrive_accounts)); } catch { /* ignore */ }
        }
      })
      .catch(() => setError("Failed to load settings"))
      .finally(() => setLoading(false));

    fetch("/api/health")
      .then((r) => r.json())
      .then((data) => setHealthChecks(data.checks))
      .catch(() => {});

    const params = new URLSearchParams(window.location.search);
    if (params.get("gdrive_success")) {
      window.history.replaceState({}, "", window.location.pathname);
    }
    if (params.get("gdrive_error")) {
      setError(`OAuth error: ${params.get("gdrive_error")}`);
      window.history.replaceState({}, "", window.location.pathname);
    }
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

  async function saveGDriveAccounts(accounts: GDriveAccount[]): Promise<void> {
    setGdAccounts(accounts);
    await updateSetting("gdrive_accounts", JSON.stringify(accounts));
  }

  async function reloadGDriveAccounts(): Promise<void> {
    try {
      const res = await fetch("/api/settings");
      const data = await res.json();
      if (data.gdrive_accounts) {
        setGdAccounts(JSON.parse(data.gdrive_accounts));
      }
    } catch { /* ignore */ }
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
    "teamhub": "teamhub team hub context injection shared",
    "context-trash": "compress on input compression hook ocr screenshot json context trash",
    "compact-by-parts": "compact by parts pre-compact compression gemini threshold",
    "context-sources": "context sources github url local knowledge",
    "gdrive": "gdrive google drive accounts oauth service",
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

        {/* ── TeamHub ──────────────────────────────────────── */}
        {sectionVisible("teamhub") && <TeamHubSection
          enabled={settings.teamhub_enabled !== "false"}
          onToggle={(v) => updateSetting("teamhub_enabled", v ? "true" : "false")}
        />}

        {/* ── Context Trash ────────────────────────────────── */}
        {sectionVisible("context-trash") && <ContextTrashSection />}

        {/* ── Compact by Parts ────────────────────────────────── */}
        {sectionVisible("compact-by-parts") && <ContextSaverSection />}

        {/* ── Context Sources ──────────────────────────────── */}
        {sectionVisible("context-sources") && <ContextSourcesSection />}

        {/* ── Google Drive ─────────────────────────────────── */}
        {sectionVisible("gdrive") && <GDriveAccountsSection
          accounts={gdAccounts}
          savedKey={savedKey}
          onSave={saveGDriveAccounts}
          onError={(msg) => setError(msg)}
          onReloadAccounts={reloadGDriveAccounts}
        />}

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
