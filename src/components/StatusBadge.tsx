"use client";

import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  active?: boolean;
  className?: string;
}

export function StatusBadge({ active, className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-block w-2 h-2 rounded-full shrink-0",
        active
          ? "bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.5)]"
          : "bg-muted-foreground/30",
        className
      )}
      title={active ? "Active" : "Inactive"}
    />
  );
}
