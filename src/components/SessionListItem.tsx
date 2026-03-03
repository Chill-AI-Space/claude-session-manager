"use client";

import Link from "next/link";
import { SessionListItem } from "@/lib/types";
import { StatusBadge } from "./StatusBadge";
import { cn } from "@/lib/utils";
import { GitBranch } from "lucide-react";

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
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatShortTime(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  if (isToday) return `Today ${formatShortTime(dateStr)}`;
  if (isYesterday) return `Yesterday ${formatShortTime(dateStr)}`;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getSessionTitle(session: SessionListItem): string {
  if (session.custom_name) return session.custom_name;
  if (session.generated_title) return session.generated_title;
  if (session.first_prompt) {
    const text = session.first_prompt;
    if (text.startsWith("[Request interrupted")) {
      return session.session_id.slice(0, 8) + "...";
    }
    const firstLine = text.split("\n")[0].trim();
    return firstLine.length > 100
      ? firstLine.slice(0, 100) + "..."
      : firstLine;
  }
  return session.session_id.slice(0, 8) + "...";
}

function truncatePreview(text: string | null, maxLen: number): string | null {
  if (!text) return null;
  const firstLine = text.split("\n")[0].trim();
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.slice(0, maxLen) + "...";
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toString();
}

export function SessionListItemComponent({
  session,
  selected,
}: SessionListItemProps) {
  const title = getSessionTitle(session);
  const lastMessagePreview = truncatePreview(session.last_message, 120);
  const totalTokens =
    session.total_input_tokens + session.total_output_tokens;

  return (
    <Link
      href={`/sessions/${session.session_id}`}
      className={cn(
        "block px-3 py-2.5 mx-1 rounded cursor-pointer transition-colors",
        selected
          ? "bg-accent text-accent-foreground"
          : "hover:bg-accent/50"
      )}
    >
      {/* Row 1: Status + Title + Time */}
      <div className="flex items-start gap-2">
        <StatusBadge active={session.is_active} className="mt-1" />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5 min-w-0">
            <span className="text-[13px] font-medium min-w-0 flex-1 leading-snug line-clamp-2">
              {title}
            </span>
            <span className="text-[10px] text-muted-foreground/70 shrink-0 tabular-nums">
              {formatRelativeTime(session.modified_at)}
            </span>
          </div>

          {/* Row 2: Last message preview */}
          {lastMessagePreview && (
            <p className="text-[11px] text-muted-foreground/80 mt-0.5 line-clamp-1 leading-relaxed">
              {lastMessagePreview}
            </p>
          )}

          {/* Row 3: Meta — timestamps, branch, tokens */}
          <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground/60 flex-wrap">
            <span className="tabular-nums">
              {formatDate(session.created_at)}
            </span>
            {session.created_at !== session.modified_at && (
              <>
                <span>-</span>
                <span className="tabular-nums">
                  {formatDate(session.modified_at)}
                </span>
              </>
            )}
            <span>{session.message_count} msgs</span>
            {totalTokens > 0 && (
              <span>{formatTokens(totalTokens)} tok</span>
            )}
            {session.git_branch && session.git_branch !== "HEAD" && (
              <span className="flex items-center gap-0.5">
                <GitBranch className="h-2.5 w-2.5" />
                {session.git_branch}
              </span>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}
