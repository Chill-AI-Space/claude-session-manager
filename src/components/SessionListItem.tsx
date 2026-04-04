"use client";

import { memo } from "react";
import Link from "next/link";
import { SessionListItem } from "@/lib/types";
import { StatusBadge } from "./StatusBadge";
import { cn, formatTokens } from "@/lib/utils";
import { getActivityStatus } from "@/lib/activity-status";
import { GitBranch, Archive, Cloud } from "lucide-react";

interface SessionListItemProps {
  session: SessionListItem;
  selected: boolean;
  snippet?: string;
  highlightQuery?: string;
  now?: number;
  onArchive?: (sessionId: string) => void;
}

function formatRelativeTime(dateStr: string, now: number): string {
  const diffMs = now - new Date(dateStr).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatShortTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatDate(dateStr: string, now: number): string {
  const date = new Date(dateStr);
  const nowDate = new Date(now);
  const isToday = date.toDateString() === nowDate.toDateString();
  const yesterday = new Date(nowDate);
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
    let text = session.first_prompt;
    if (text.startsWith("[Request interrupted")) return session.session_id.slice(0, 8) + "...";
    // Strip <context> blocks (before or after user message) so list shows actual content
    text = text.replace(/<context>[\s\S]*?<\/context>/gi, "").trim();
    if (!text) return session.session_id.slice(0, 8) + "...";
    const firstLine = text.split("\n")[0].trim();
    return firstLine.length > 100 ? firstLine.slice(0, 100) + "..." : firstLine;
  }
  return session.session_id.slice(0, 8) + "...";
}

function truncatePreview(text: string | null, maxLen: number): string | null {
  if (!text) return null;
  const firstLine = text.split("\n")[0].trim();
  return firstLine.length <= maxLen ? firstLine : firstLine.slice(0, maxLen) + "...";
}

export const SessionListItemComponent = memo(
  function SessionListItemComponent({
    session,
    selected,
    snippet,
    highlightQuery,
    now = Date.now(),
    onArchive,
  }: SessionListItemProps) {
    const title = getSessionTitle(session);
    const activityStatus = getActivityStatus(session, now);
    const lastMessagePreview = truncatePreview(session.last_message, 120);
    const totalTokens = session.total_input_tokens + session.total_output_tokens;

    const nodeParam = session._remote && session._nodeId ? `node=${session._nodeId}` : "";
    const qParam = highlightQuery ? `q=${encodeURIComponent(highlightQuery)}` : "";
    const queryString = [nodeParam, qParam].filter(Boolean).join("&");
    const href = `/claude-sessions/${session.session_id}${queryString ? `?${queryString}` : ""}`;

    return (
      <Link
        href={href}
        prefetch={false}
        className={cn(
          "group/item block py-2.5 mx-1 rounded cursor-pointer transition-colors relative",
          selected
            ? "bg-accent text-accent-foreground border-l-2 border-primary pl-2.5 pr-3"
            : "hover:bg-accent/50 px-3"
        )}
      >
        {onArchive && (
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onArchive(session.session_id); }}
            className="absolute top-1.5 right-1.5 p-1 rounded opacity-0 group-hover/item:opacity-100 hover:bg-muted text-muted-foreground/50 hover:text-muted-foreground transition-all z-20"
            title="Archive session"
          >
            <Archive className="h-3 w-3" />
          </button>
        )}
        <div className="flex items-start gap-2">
          <StatusBadge status={activityStatus} className="mt-1" />
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-1.5 min-w-0">
              {session._remote && (
                <span title={session._nodeName || "Remote"}>
                  <Cloud className="h-3 w-3 text-sky-500 shrink-0 relative top-[1px]" />
                </span>
              )}
              <span className="text-[13px] font-medium min-w-0 flex-1 leading-snug line-clamp-2">
                {title}
              </span>
              {activityStatus === "active" ? (
                <span className="text-[10px] text-green-600 dark:text-green-400 shrink-0 font-medium">
                  Working...
                </span>
              ) : activityStatus === "interrupted" ? (
                <span className="text-[10px] text-orange-600 dark:text-orange-400 shrink-0 font-medium">
                  Crashed
                </span>
              ) : activityStatus === "waiting" ? (
                <span className="text-[10px] text-blue-600 dark:text-blue-400 shrink-0 font-medium">
                  Awaiting reply
                </span>
              ) : (
                <span className="text-[10px] text-muted-foreground/70 shrink-0 tabular-nums">
                  {formatRelativeTime(session.modified_at, now)}
                </span>
              )}
            </div>

            {snippet ? (
              <p className="text-[11px] text-amber-500/80 mt-0.5 line-clamp-2 leading-relaxed">
                {snippet}
              </p>
            ) : lastMessagePreview ? (
              <p className="text-[11px] text-muted-foreground/80 mt-0.5 line-clamp-1 leading-relaxed">
                {lastMessagePreview}
              </p>
            ) : null}

            <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground/60 flex-wrap">
              <span className="tabular-nums">{formatDate(session.created_at, now)}</span>
              {session.created_at !== session.modified_at && (
                <>
                  <span>-</span>
                  <span className="tabular-nums">{formatDate(session.modified_at, now)}</span>
                </>
              )}
              <span>{session.message_count} msgs</span>
              {totalTokens > 0 && <span>{formatTokens(totalTokens)} tok</span>}
              {session.git_branch && session.git_branch !== "HEAD" && (
                <span className="flex items-center gap-0.5">
                  <GitBranch className="h-2.5 w-2.5" />
                  {session.git_branch}
                </span>
              )}
              {session.agent_type === "forge" && (
                <span className="text-[9px] font-semibold uppercase tracking-wide text-orange-400/80 px-1 py-0.5 rounded border border-orange-400/20 bg-orange-500/5">forge</span>
              )}
            </div>
          </div>
        </div>
      </Link>
    );
  },
  // Custom equality: skip re-render unless something actually changed
  (prev, next) => {
    // Bucket `now` into 10-second intervals so minor tick changes don't re-render
    const nowBucket = (n: number) => Math.floor(n / 10_000);
    return (
      prev.session.session_id === next.session.session_id &&
      prev.session.modified_at === next.session.modified_at &&
      prev.session.generated_title === next.session.generated_title &&
      prev.session.custom_name === next.session.custom_name &&
      prev.session.last_message === next.session.last_message &&
      prev.session.message_count === next.session.message_count &&
      prev.session.is_active === next.session.is_active &&
      prev.session.last_message_role === next.session.last_message_role &&
      prev.session._remote === next.session._remote &&
      prev.selected === next.selected &&
      prev.snippet === next.snippet &&
      prev.highlightQuery === next.highlightQuery &&
      nowBucket(prev.now ?? 0) === nowBucket(next.now ?? 0) &&
      prev.onArchive === next.onArchive
    );
  }
);
