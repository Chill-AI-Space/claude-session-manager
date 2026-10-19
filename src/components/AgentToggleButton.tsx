"use client";

import { useEffect, useState } from "react";
import type { AgentType } from "@/lib/agents";

export type { AgentType } from "@/lib/agents";

export const AGENT_CYCLE: Record<AgentType, AgentType> = {
  claude: "opencode",
  opencode: "forge",
  forge: "codex",
  codex: "claude",
};

export const DEFAULT_MODEL: Record<AgentType, string> = {
  claude: "",
  opencode: "",
  forge: "models/gemini-2.5-flash",
  codex: "gpt-5.5",
};

interface AgentToggleButtonProps {
  agent: AgentType;
  onCycle: (next: AgentType) => void;
  buildId?: string;
  onBuildChange?: (id: string | undefined) => void;
  size?: "sm" | "md";
}

/** Fork builds that should sit right after Codex, before Claude. */
const PREFERRED_BUILD_IDS = ["mem-latest", "mem-previous"];

function orderBuilds(builds: AgentBuild[]): AgentBuild[] {
  const preferred = PREFERRED_BUILD_IDS
    .map((id) => builds.find((b) => b.id === id))
    .filter((b): b is AgentBuild => Boolean(b));
  const rest = builds.filter((b) => !PREFERRED_BUILD_IDS.includes(b.id));
  return [...preferred, ...rest];
}

interface AgentBuild {
  id: string;
  name: string;
  kind: string;
  available: boolean;
  builtAt?: string;
  pullRequest?: string;
  description?: string;
}

export function AgentToggleButton({ agent, onCycle, buildId, onBuildChange, size = "sm" }: AgentToggleButtonProps) {
  const [builds, setBuilds] = useState<AgentBuild[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/opencode/builds").then(async (r) => {
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setBuilds(data.builds);
    }).catch((e) => setError(String(e)));
  }, []);
  const ordered = orderBuilds(builds);
  const forkBuilds = ordered.filter((b) => b.kind !== "upstream");
  const upstreamBuilds = ordered.filter((b) => b.kind === "upstream");
  const renderBuild = (b: AgentBuild) => (
    <option key={b.id} value={`build:${b.id}`} disabled={!b.available} title={b.description}>
      {b.name}{b.pullRequest ? ` · ${b.pullRequest}` : ""}{b.builtAt ? ` · ${b.builtAt.slice(0, 10)}` : ""}{!b.available ? " (unavailable)" : ""}
    </option>
  );
  return (
    <select
      aria-label="Agent and OpenCode build"
      title={error || "Choose agent or OpenCode build"}
      value={agent === "opencode" && buildId ? `build:${buildId}` : agent}
      onChange={(e) => {
        const value = e.target.value;
        onBuildChange?.(value.startsWith("build:") ? value.slice(6) : undefined);
        onCycle(value.startsWith("build:") ? "opencode" : value as AgentType);
      }}
      className={`text-[11px] font-medium rounded border border-border bg-card text-foreground max-w-[260px] ${size === "md" ? "px-2 py-1" : "px-1.5 py-0.5"}`}
    >
      <option value="codex">Codex</option>
      {onBuildChange && forkBuilds.map(renderBuild)}
      <option value="claude">Claude</option>
      {onBuildChange && upstreamBuilds.map(renderBuild)}
      <option value="opencode">OpenCode (installed)</option>
      <option value="forge">Forge</option>
      {error && <option disabled>Build catalog unavailable</option>}
    </select>
  );
}
