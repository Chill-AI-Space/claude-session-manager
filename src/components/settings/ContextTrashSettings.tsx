"use client";

import { useState, useEffect } from "react";
import { Loader2, Check } from "lucide-react";

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

export function ContextTrashSettings() {
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
