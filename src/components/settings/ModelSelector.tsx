"use client";

import { Brain } from "lucide-react";
import type { AgentType } from "@/components/AgentToggleButton";

export interface ModelPreset {
  id: string;
  name: string;
  model: string;
  category: "fast" | "balanced" | "quality";
  description?: string;
}

export const MODEL_PRESETS: ModelPreset[] = [
  // Claude models (default)
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    model: "claude-opus-5-5",
    category: "quality",
    description: "Default — most capable",
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    model: "claude-sonnet-5",
    category: "balanced",
    description: "Efficient everyday Claude model",
  },
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    model: "claude-opus-5",
    category: "quality",
    description: "Previous Opus",
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    model: "claude-sonnet-4-6",
    category: "balanced",
    description: "Previous default",
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    model: "claude-opus-4-6",
    category: "quality",
    description: "Previous Opus",
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    model: "claude-haiku-4-5-20251001",
    category: "fast",
    description: "Fastest Claude model",
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    model: "models/gemini-2.5-flash",
    category: "fast",
    description: "Google Gemini 2.5 Flash (Forge default)",
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    model: "models/gemini-2.5-pro",
    category: "quality",
    description: "Google Gemini 2.5 Pro",
  },
  {
    id: "gemini-flash-lite-latest",
    name: "Gemini Flash Lite",
    model: "models/gemini-flash-lite-latest",
    category: "fast",
    description: "Google Gemini Flash Lite (latest)",
  },
  {
    id: "gemini-2.0-flash",
    name: "Gemini 2.0 Flash",
    model: "models/gemini-2.0-flash",
    category: "fast",
    description: "Google Gemini 2.0 Flash",
  },
];

export function getModelPresetsForAgent(agent: AgentType): ModelPreset[] {
  if (agent === "forge") {
    return MODEL_PRESETS.filter(
      (preset) => preset.model.startsWith("models/gemini") || preset.model.startsWith("gemini"),
    );
  }

  if (agent === "codex") {
    // Deliberately empty: Codex model ids come from ~/.codex/models_cache.json
    // (Sol / Astra / Luna / Terra), not from this hardcoded table, so use
    // `useModelPresetsForAgent()` / `useCodexModels()` instead — they read the
    // live cache over /api/codex/models. See src/lib/codex-models.ts.
    return [];
  }

  if (agent === "opencode") {
    // OpenCode doesn't take Claude-style model IDs (this list) as an `-m`
    // value — it's driven by named profiles instead. See
    // OpencodeProfileSelector / src/lib/opencode-profiles.ts.
    return [];
  }

  return MODEL_PRESETS.filter((preset) => preset.model.startsWith("claude"));
}

export function getDefaultModelForAgent(agent: AgentType, claudeModel?: string): string {
  if (agent === "forge") {
    if (claudeModel && (claudeModel.startsWith("models/gemini") || claudeModel.startsWith("gemini"))) {
      return claudeModel;
    }
    return "models/gemini-2.5-flash";
  }

  if (agent === "codex") {
    // Matches DEFAULT_CODEX_MODEL in src/lib/codex-models.ts — duplicated as
    // a literal for the same reason as the opencode profile below (that module
    // reads the filesystem, so it can't be imported from a client component).
    // This is only the pre-fetch placeholder: once /api/codex/models responds,
    // `useCodexModels().defaultModel` replaces it with the live top choice.
    return "gpt-6.1-sol";
  }

  if (agent === "opencode") {
    // Matches DEFAULT_OPENCODE_PROFILE in src/lib/opencode-profiles.ts —
    // duplicated as a literal here since that module pulls in Node's `fs`
    // and can't be imported from this client component. Keep these two
    // in sync by hand; drift here breaks session creation outright
    // ("Unknown OpenCode profile: <stale name>").
    return "master";
  }

  return claudeModel || "claude-opus-5-5";
}

interface ModelSelectorProps {
  settingKey: string;
  currentModel: string;
  onUpdate: (key: string, value: string) => void;
  label?: string;
  presets?: ModelPreset[];
}

export function ModelSelector({
  settingKey,
  currentModel,
  onUpdate,
  label = "AI Model",
  presets = MODEL_PRESETS,
}: ModelSelectorProps) {
  // Find current preset or use custom
  const currentPreset = presets.find((p) => p.model === currentModel);

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onUpdate(settingKey, e.target.value);
  };

  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-muted-foreground/60">{label}:</span>
      <div className="relative">
        <Brain className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50 pointer-events-none" />
        <select
          value={currentPreset?.model || currentModel}
          onChange={handleChange}
          className="pl-8 pr-8 py-1.5 text-xs h-7 rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground cursor-pointer min-w-[200px] appearance-none"
        >
          {presets.map((preset) => (
            <option key={preset.id} value={preset.model}>
              {preset.name} {preset.description && `- ${preset.description}`}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
