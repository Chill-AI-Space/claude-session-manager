"use client";

import { Brain } from "lucide-react";

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
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    model: "claude-sonnet-4-6",
    category: "balanced",
    description: "Default Claude model",
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    model: "claude-opus-4-6",
    category: "quality",
    description: "Highest quality",
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    model: "claude-haiku-4-5-20251001",
    category: "fast",
    description: "Fastest Claude model",
  },
  // OpenAI / Codex models
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    model: "gpt-5.4",
    category: "quality",
    description: "OpenAI GPT-5.4 (Codex default)",
  },
  {
    id: "gpt-4o",
    name: "GPT-4o",
    model: "gpt-4o",
    category: "balanced",
    description: "OpenAI GPT-4o",
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

interface ModelSelectorProps {
  settingKey: string;
  currentModel: string;
  onUpdate: (key: string, value: string) => void;
  label?: string;
}

export function ModelSelector({
  settingKey,
  currentModel,
  onUpdate,
  label = "AI Model",
}: ModelSelectorProps) {
  // Find current preset or use custom
  const currentPreset = MODEL_PRESETS.find((p) => p.model === currentModel);

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
          {MODEL_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.model}>
              {preset.name} {preset.description && `- ${preset.description}`}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
