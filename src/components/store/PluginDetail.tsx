"use client";

import { useState, useEffect } from "react";
import { ExternalLink, CheckCircle2, Construction, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PluginData, PluginStatus } from "./PluginCard";

const STATUS_CONFIG: Record<PluginStatus, { label: string; className: string }> = {
  installed: { label: "Installed", className: "text-green-600 dark:text-green-400" },
  available: { label: "Available", className: "text-muted-foreground" },
  in_progress: { label: "In progress", className: "text-amber-600 dark:text-amber-400" },
  requested: { label: "Requested", className: "text-blue-600 dark:text-blue-400" },
};

interface PluginDetailProps {
  plugin: PluginData;
  installing: boolean;
  installLog: string | null;
  onToggleInstall: (id: string) => void;
  settings: Record<string, string | undefined>;
  onUpdateSetting: (key: string, value: string) => void;
  savedKey: string | null;
}

export function PluginDetail({
  plugin,
  installing,
  installLog,
  onToggleInstall,
  settings,
  onUpdateSetting,
  savedKey,
}: PluginDetailProps) {
  const statusCfg = STATUS_CONFIG[plugin.status];
  const SettingsComponent = plugin.settingsComponent;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="shrink-0 mt-0.5 text-muted-foreground">
          {plugin.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-base font-semibold">{plugin.name}</h2>
            <span className={`text-[11px] font-medium ${statusCfg.className}`}>
              {statusCfg.label}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className="text-[10px] text-muted-foreground/60 bg-muted/50 px-1.5 py-0.5 rounded">
              {plugin.category}
            </span>
            {plugin.standalone && (
              <span className="text-[10px] text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded">
                standalone
              </span>
            )}
            {plugin.tags.map((tag) => (
              <span key={tag} className="text-[10px] font-mono text-muted-foreground/50 bg-muted/30 border border-border/50 px-1.5 py-0.5 rounded">
                {tag}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Description */}
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground leading-relaxed">
          {plugin.description}
        </p>
        <p className="text-[11px] text-muted-foreground/60 leading-relaxed">
          {plugin.longDescription}
        </p>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        {plugin.status === "in_progress" ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1.5 border-amber-500/30 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10"
            disabled
          >
            <Construction className="h-3 w-3" />
            In progress
          </Button>
        ) : plugin.status === "requested" ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1.5 border-blue-500/30 text-blue-600 dark:text-blue-400 hover:bg-blue-500/10"
            disabled
          >
            <Sparkles className="h-3 w-3" />
            Requested
          </Button>
        ) : (
          <Button
            size="sm"
            variant={plugin.status === "installed" ? "secondary" : "default"}
            className="h-7 text-xs gap-1.5"
            onClick={() => onToggleInstall(plugin.id)}
            disabled={installing}
          >
            {installing ? (
              <>Installing...</>
            ) : plugin.status === "installed" ? (
              <>
                <CheckCircle2 className="h-3 w-3" />
                Installed
              </>
            ) : plugin.id === "permission-bridge" ? (
              <>Install</>
            ) : plugin.standalone ? (
              <>Standalone install</>
            ) : (
              <>Get</>
            )}
          </Button>
        )}
        {plugin.links?.map((link) => (
          <a
            key={link.href}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
          >
            <ExternalLink className="h-2.5 w-2.5" />
            {link.label}
          </a>
        ))}
      </div>

      {/* Install log */}
      {installLog && plugin.id === "permission-bridge" && (
        <pre className="text-[10px] text-muted-foreground bg-muted/50 border border-border/30 rounded p-2 whitespace-pre-wrap font-mono max-h-32 overflow-y-auto">
          {installLog}
        </pre>
      )}

      {/* Settings panel */}
      {SettingsComponent && plugin.status === "installed" && (
        <div className="border-t border-border pt-5 mt-5">
          <SettingsComponent
            settings={settings}
            onUpdate={onUpdateSetting}
            savedKey={savedKey}
          />
        </div>
      )}
    </div>
  );
}
