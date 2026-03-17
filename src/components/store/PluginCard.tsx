"use client";

import { CheckCircle2, Construction, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

export type PluginStatus = "installed" | "available" | "in_progress" | "requested";

export interface PluginData {
  id: string;
  name: string;
  description: string;
  longDescription: string;
  category: string;
  tags: string[];
  icon: React.ReactNode;
  status: PluginStatus;
  standalone?: boolean;
  repo?: string;
  links?: { label: string; href: string }[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  settingsComponent?: React.ComponentType<any>;
  settingsKeys?: string[];
}

const STATUS_DOT: Record<PluginStatus, string> = {
  installed: "bg-green-500",
  available: "bg-zinc-400",
  in_progress: "bg-amber-500",
  requested: "bg-blue-400",
};

interface PluginCardProps {
  plugin: PluginData;
  selected: boolean;
  onClick: () => void;
}

export function PluginCard({ plugin, selected, onClick }: PluginCardProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left px-3 py-2.5 rounded-lg border transition-colors",
        selected
          ? "border-primary/50 bg-primary/5"
          : "border-transparent hover:bg-muted/50"
      )}
    >
      <div className="flex items-center gap-2.5">
        <div className="shrink-0 text-muted-foreground/70">
          {plugin.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{plugin.name}</span>
            <div className={cn("h-1.5 w-1.5 rounded-full shrink-0", STATUS_DOT[plugin.status])} />
            {plugin.settingsComponent && (
              <span className="text-[9px] text-muted-foreground/40 shrink-0">⚙</span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground/70 truncate mt-0.5">
            {plugin.description}
          </p>
        </div>
      </div>
    </button>
  );
}
