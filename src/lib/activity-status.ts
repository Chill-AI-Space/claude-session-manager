import type { ActivityStatus } from "@/components/StatusBadge";

/**
 * Determine the activity status of a session based on its active flag and age.
 *
 * Active = process running AND file written recently (< 2 min).
 * If process is alive but idle for >2min, it's just waiting, not "active".
 */
export function getActivityStatus(
  session: { is_active?: boolean; modified_at: string; last_message_role?: string | null },
  now: number = Date.now()
): ActivityStatus {
  const ageMs = now - new Date(session.modified_at).getTime();
  if (session.is_active) {
    // Distinguish: Claude computing (last msg was from user) vs waiting at prompt (last msg was assistant)
    return session.last_message_role === "assistant" ? "terminal-open" : "active";
  }
  if (ageMs < 30_000) return "recent-30s";
  if (ageMs < 3 * 60_000) return "recent-3m";
  // "interrupted" = Claude died mid-tool-execution (last message is a tool_result, no process)
  if (!session.is_active && session.last_message_role === "tool_result" && ageMs < 2 * 60 * 60_000) return "interrupted";
  // "waiting" = Claude's last message is unanswered (only shown for recent sessions)
  if (!session.is_active && session.last_message_role === "assistant" && ageMs < 48 * 60 * 60_000) return "waiting";
  return "inactive";
}
