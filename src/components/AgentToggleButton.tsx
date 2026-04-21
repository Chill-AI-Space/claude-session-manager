"use client";

import { Hammer } from "lucide-react";

export type AgentType = "claude" | "forge" | "codex";

export const AGENT_CYCLE: Record<AgentType, AgentType> = {
  claude: "forge",
  forge: "codex",
  codex: "claude",
};

export const DEFAULT_MODEL: Record<AgentType, string> = {
  claude: "",
  forge: "models/gemini-2.5-flash",
  codex: "gpt-5.4",
};

interface AgentToggleButtonProps {
  agent: AgentType;
  onCycle: (next: AgentType) => void;
  size?: "sm" | "md";
}

export function AgentToggleButton({ agent, onCycle, size = "sm" }: AgentToggleButtonProps) {
  const next = AGENT_CYCLE[agent];
  const titles: Record<AgentType, string> = {
    claude: "Using Claude — click to switch to Forge",
    forge: "Using Forge — click to switch to Codex",
    codex: "Using Codex — opens in terminal, click to switch to Claude",
  };

  const px = size === "md" ? "px-2 py-0.5" : "px-1.5 py-0.5";

  return (
    <button
      onClick={() => onCycle(next)}
      className={`flex items-center gap-1 text-[11px] font-medium transition-colors ${px} rounded border ${
        agent === "forge"
          ? "text-orange-400 border-orange-400/40 bg-orange-500/10 hover:bg-orange-500/20"
          : agent === "codex"
            ? "text-violet-400 border-violet-400/40 bg-violet-500/10 hover:bg-violet-500/20"
            : "text-muted-foreground/50 border-border hover:text-foreground hover:bg-muted/50"
      }`}
      title={titles[agent]}
      type="button"
    >
      {agent === "forge" ? (
        <Hammer className="h-3 w-3" />
      ) : agent === "codex" ? (
        <span className="text-[10px] font-bold leading-none">{"{ }"}</span>
      ) : (
        <span className="text-[10px] font-bold leading-none">C</span>
      )}
      <span>{agent}</span>
    </button>
  );
}
