export type AgentType = "claude" | "forge" | "codex" | "opencode";

const AGENT_TYPES: readonly string[] = ["claude", "forge", "codex", "opencode"];

export function isAgentType(value: unknown): value is AgentType {
  return typeof value === "string" && AGENT_TYPES.includes(value);
}

/**
 * Agent a composer shows before settings arrive, and what it falls back to
 * when `default_agent` is unset or garbage. Must stay in sync with the
 * server-side default in src/lib/db.ts — a composer that renders one agent
 * and a /api/sessions/start that defaults to another means the picker lies
 * about what the started session will actually be.
 */
export const FALLBACK_AGENT: AgentType = "opencode";