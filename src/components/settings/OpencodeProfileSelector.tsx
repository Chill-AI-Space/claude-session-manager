"use client";

import { Layers } from "lucide-react";
import { useOpencodeProfiles } from "@/hooks/useOpencodeProfiles";

interface OpencodeProfileSelectorProps {
  currentProfile: string;
  onUpdate: (profileId: string) => void;
  label?: string;
}

/**
 * Model-profile picker for OpenCode sessions, shown in place of the Claude
 * model dropdown. OpenCode has no notion of a single "model" the way Claude
 * does — this setup switches between named profiles (Quality, Value, Free,
 * Mimo, Russian Recruiter, Lavish Luna, ...) read from
 * ~/.config/opencode/profiles, each of which sets models for several
 * OpenCode roles (build/plan/explore/general/review) at once. See
 * src/lib/opencode-profiles.ts for how a chosen profile is applied.
 */
export function OpencodeProfileSelector({ currentProfile, onUpdate, label = "Profile" }: OpencodeProfileSelectorProps) {
  const { profiles, currentProfile: defaultProfile, loaded } = useOpencodeProfiles();

  const selectedProfile = currentProfile || defaultProfile;

  if (loaded && profiles.length === 0) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground/60">
        <Layers className="h-3.5 w-3.5" />
        <span>No OpenCode profiles found in ~/.config/opencode/profiles</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-muted-foreground/60">{label}:</span>
      <div className="relative">
        <Layers className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50 pointer-events-none" />
        <select
          value={selectedProfile}
          onChange={(e) => onUpdate(e.target.value)}
          className="pl-8 pr-8 py-1.5 text-xs h-7 rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground cursor-pointer min-w-[200px] appearance-none"
        >
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name} {profile.description && `- ${profile.description}`}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
