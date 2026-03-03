"use client";

import Link from "next/link";
import { SessionListItem } from "@/lib/types";
import { StatusBadge } from "./StatusBadge";
import { cn } from "@/lib/utils";

interface SessionListItemProps {
  session: SessionListItem;
  selected: boolean;
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function getSessionTitle(session: SessionListItem): string {
  if (session.custom_name) return session.custom_name;
  if (session.first_prompt) {
    const text = session.first_prompt;
    if (text.startsWith("[Request interrupted")) {
      return session.session_id.slice(0, 8) + "...";
    }
    const firstLine = text.split("\n")[0].trim();
    return firstLine.length > 80
      ? firstLine.slice(0, 80) + "..."
      : firstLine;
  }
  return session.session_id.slice(0, 8) + "...";
}

export function SessionListItemComponent({
  session,
  selected,
}: SessionListItemProps) {
  const title = getSessionTitle(session);

  return (
    <Link
      href={`/sessions/${session.session_id}`}
      className={cn(
        "block px-3 py-2 mx-1 rounded cursor-pointer transition-colors",
        selected
          ? "bg-accent text-accent-foreground"
          : "hover:bg-accent/50"
      )}
    >
      <div className="flex items-start gap-2">
        <StatusBadge active={session.is_active} className="mt-1.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5 min-w-0">
            <span className="text-[13px] font-medium truncate min-w-0 flex-1 leading-snug">
              {title}
            </span>
            <span className="text-[11px] text-muted-foreground shrink-0">
              {formatRelativeTime(session.modified_at)}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[11px] text-muted-foreground">
              {session.message_count} msgs
            </span>
            {session.git_branch && session.git_branch !== "HEAD" && (
              <span className="text-[10px] text-muted-foreground/60 truncate">
                {session.git_branch}
              </span>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}
