"use client";

import { useEffect, useState } from "react";
import type { ModelPreset } from "@/components/settings/ModelSelector";
import { getDefaultModelForAgent, getModelPresetsForAgent } from "@/components/settings/ModelSelector";
import type { AgentType } from "@/lib/agents";

interface CodexModel {
  slug: string;
  displayName: string;
  description?: string;
}

// Same value as DEFAULT_CODEX_MODEL in src/lib/codex-models.ts, which can't be
// imported here (it reads the filesystem). Only the placeholder shown before
// /api/codex/models responds.
const PLACEHOLDER_DEFAULT = "gpt-6.1-sol";

/**
 * Model dropdown options for an agent, plus the model to preselect.
 *
 * For codex this comes from ~/.codex/models_cache.json (served by
 * /api/codex/models) rather than the static MODEL_PRESETS table, which has no
 * current Codex entries — the slugs this account sees (Sol, Astra, Luna,
 * Terra) replaced gpt-5.4/gpt-4o. For every other agent this is exactly
 * getModelPresetsForAgent() / getDefaultModelForAgent(); only codex differs,
 * and getDefaultModelForAgent("codex") is kept in sync as its placeholder.
 */
export function useAgentModels(agent: AgentType, claudeModel?: string): { presets: ModelPreset[]; defaultModel: string } {
  const [codexModels, setCodexModels] = useState<CodexModel[]>([]);
  const [codexDefault, setCodexDefault] = useState<string>(PLACEHOLDER_DEFAULT);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/codex/models")
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return;
        if (Array.isArray(data.models) && data.models.length > 0) setCodexModels(data.models);
        if (typeof data.defaultModel === "string" && data.defaultModel) setCodexDefault(data.defaultModel);
      })
      .catch(() => {
        // Server unreachable, or Codex has no cache and the route's static
        // fallback couldn't be read either — keep the placeholder default and
        // an empty list, which renders the same way opencode's does.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (agent === "codex") {
    return {
      presets: codexModels.map((model) => ({
        id: model.slug,
        name: model.displayName,
        model: model.slug,
        category: "quality",
        description: model.description,
      })),
      defaultModel: codexDefault,
    };
  }

  return {
    presets: getModelPresetsForAgent(agent),
    defaultModel: getDefaultModelForAgent(agent, claudeModel),
  };
}