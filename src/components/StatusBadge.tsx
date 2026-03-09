"use client";

import { cn } from "@/lib/utils";

export type ActivityStatus = "active" | "terminal-open" | "recent-30s" | "recent-3m" | "inactive" | "waiting" | "interrupted";

interface StatusBadgeProps {
  status: ActivityStatus;
  className?: string;
}

const STATUS_STYLES: Record<ActivityStatus, { dot: string; title: string }> = {
  "active":         { dot: "bg-green-500 shadow-[0_0_7px_rgba(34,197,94,0.7)] animate-pulse",  title: "Claude is working" },
  "terminal-open":  { dot: "bg-green-400/60",                                                   title: "Terminal open — waiting for input" },
  "recent-30s":     { dot: "bg-green-400 shadow-[0_0_5px_rgba(74,222,128,0.5)]",               title: "Just ended" },
  "recent-3m":      { dot: "bg-green-300/70",                                                   title: "Recently active" },
  "inactive":       { dot: "bg-muted-foreground/30",                                            title: "Inactive" },
  "waiting":        { dot: "bg-blue-500 shadow-[0_0_7px_rgba(59,130,246,0.7)] animate-pulse",  title: "Waiting for your reply" },
  "interrupted":    { dot: "bg-orange-500 shadow-[0_0_7px_rgba(249,115,22,0.7)] animate-pulse", title: "Claude crashed — will auto-retry" },
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const { dot, title } = STATUS_STYLES[status];
  return (
    <span
      className={cn("inline-block w-2 h-2 rounded-full shrink-0", dot, className)}
      title={title}
    />
  );
}
