"use client";

import { SettingsComponentProps } from "./types";

export function WorkersSettings({ settings, onUpdate }: SettingsComponentProps) {
  return (
    <div className="space-y-6">
      <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
        External Workers
      </h2>
      <p className="text-xs text-muted-foreground">
        External workers (e.g. research-worker.sh) register via API, send heartbeats, and process tasks.
        If a worker goes offline, the fallback chain triggers: AI → email notification.
      </p>

      {/* Heartbeat timeout */}
      <div className="space-y-1">
        <div className="text-sm font-medium">Heartbeat timeout</div>
        <p className="text-xs text-muted-foreground">
          How long to wait after the last heartbeat before marking a worker as offline (ms).
        </p>
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={settings.worker_heartbeat_timeout_ms || "300000"}
            onChange={(e) => onUpdate("worker_heartbeat_timeout_ms", e.target.value)}
            onBlur={(e) => onUpdate("worker_heartbeat_timeout_ms", e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            className="w-32 px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <span className="text-xs text-muted-foreground">
            ({Math.round(parseInt(settings.worker_heartbeat_timeout_ms || "300000") / 60000)} min)
          </span>
        </div>
      </div>

      {/* Fallback toggle */}
      <div className="space-y-1">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.worker_fallback_enabled === "true"}
            onChange={() => {
              const val = settings.worker_fallback_enabled === "true" ? "false" : "true";
              onUpdate("worker_fallback_enabled", val);
            }}
            className="rounded border-input accent-primary"
          />
          <span className="text-sm font-medium">Enable AI fallback</span>
        </label>
        <p className="text-xs text-muted-foreground ml-5">
          When a worker goes offline, try to complete pending tasks via Claude API before sending &ldquo;expert needed&rdquo; email.
        </p>
      </div>

      {/* Fallback model */}
      {settings.worker_fallback_enabled === "true" && (
        <div className="space-y-1">
          <div className="text-sm font-medium">Fallback model</div>
          <input
            type="text"
            value={settings.worker_fallback_model || "claude-sonnet-4-5-20250514"}
            onChange={(e) => onUpdate("worker_fallback_model", e.target.value)}
            onBlur={(e) => onUpdate("worker_fallback_model", e.target.value.trim())}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      )}

      {/* SMTP Settings */}
      <div className="space-y-3">
        <div className="text-sm font-medium">Email notifications (SMTP)</div>
        <p className="text-xs text-muted-foreground">
          Configure SMTP to send email when tasks complete or when fallback triggers.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {[
            { key: "worker_notify_smtp_host", label: "SMTP Host", placeholder: "smtp.gmail.com" },
            { key: "worker_notify_smtp_port", label: "Port", placeholder: "587" },
            { key: "worker_notify_smtp_user", label: "Username", placeholder: "user@gmail.com" },
            { key: "worker_notify_smtp_pass", label: "Password", placeholder: "app-password", type: "password" },
            { key: "worker_notify_from", label: "From", placeholder: "noreply@example.com" },
            { key: "worker_notify_to", label: "Default To", placeholder: "admin@example.com" },
          ].map(({ key, label, placeholder, type }) => (
            <div key={key} className="space-y-1">
              <label className="text-xs text-muted-foreground">{label}</label>
              <input
                type={type || "text"}
                value={settings[key] || ""}
                onChange={(e) => onUpdate(key, e.target.value)}
                onBlur={(e) => onUpdate(key, e.target.value.trim())}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                placeholder={placeholder}
                className="w-full px-2 py-1 text-xs rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          ))}
        </div>
      </div>

      {/* Webhook URL */}
      <div className="space-y-1">
        <div className="text-sm font-medium">Notification webhook</div>
        <p className="text-xs text-muted-foreground">
          POST JSON payloads to this URL on worker events (offline, fallback, task completed).
        </p>
        <input
          type="text"
          value={settings.worker_notify_webhook_url || ""}
          onChange={(e) => onUpdate("worker_notify_webhook_url", e.target.value)}
          onBlur={(e) => onUpdate("worker_notify_webhook_url", e.target.value.trim())}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          placeholder="https://hooks.example.com/worker-events"
          className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>
    </div>
  );
}
