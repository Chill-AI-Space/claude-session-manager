"use client";

import { useState } from "react";
import { CircleCheck, CircleX, Check, Copy } from "lucide-react";
import { HealthCheck } from "./types";

function HealthCheckFix({ fix }: { fix: string }) {
  const [copied, setCopied] = useState(false);

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

interface SystemHealthSettingsProps {
  healthChecks: HealthCheck[] | null;
}

export function SystemHealthSettings({ healthChecks }: SystemHealthSettingsProps) {
  if (!healthChecks) return null;

  return (
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
  );
}

export function MacOSPermissionsSettings() {
  return (
    <div className="space-y-4">
      <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
        macOS Permissions
      </h2>
      <div className="text-xs text-muted-foreground leading-relaxed">
        <strong className="text-foreground/80">Focus Terminal</strong> requires Accessibility access so it can raise the terminal window.
        Add your terminal app below, then toggle it on. On macOS, Session Manager now prefers <strong className="text-foreground/80">iTerm2</strong> automatically when it is installed.
      </div>
      <div className="border border-border rounded-md p-3 space-y-2 bg-muted/20">
        <div className="text-xs font-medium">Required: System Settings → Privacy &amp; Security → Accessibility</div>
        <div className="text-[11px] text-muted-foreground space-y-1">
          <div>• Add <strong>iTerm2</strong> if you want the preferred/default macOS path</div>
          <div>• Add <strong>Terminal.app</strong> too if you still use the built-in terminal</div>
          <div>• <strong>node</strong> is already there — that&apos;s the server process, good to keep it</div>
        </div>
        <a
          href="x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
          className="inline-flex items-center gap-1.5 mt-1 text-[11px] text-primary underline underline-offset-2 hover:opacity-80"
        >
          Open Accessibility Settings →
        </a>
      </div>
    </div>
  );
}
