import fs from "fs";
import os from "os";
import path from "path";

/**
 * OpenCode model profiles.
 *
 * OpenCode has no built-in concept of a "profile" — this project's own
 * setup uses a `oc()` shell function (in ~/.zshrc) that deep-merges
 * ~/.config/opencode/base.json with a chosen ~/.config/opencode/profiles/<id>.json
 * into ~/.config/opencode/opencode.json, and records the active profile in
 * ~/.config/opencode/.current-profile.
 *
 * Session Manager spawns the `opencode` binary directly, not through an
 * interactive zsh shell, so it never runs `oc()`. Before this module existed
 * it also had no way to pick a profile at all — it reused Claude's model
 * dropdown, which passed Claude model IDs (e.g. "claude-sonnet-5") straight
 * to `opencode run -m`, a flag that expects "provider/model" and doesn't
 * understand Claude's own model naming. This module reimplements what
 * `oc()` does so the same profile switching works when a session is started
 * from the UI.
 */

const OPENCODE_CONFIG_DIR = path.join(os.homedir(), ".config", "opencode");
const PROFILES_DIR = path.join(OPENCODE_CONFIG_DIR, "profiles");
const BASE_CONFIG_PATH = path.join(OPENCODE_CONFIG_DIR, "base.json");
const MERGED_CONFIG_PATH = path.join(OPENCODE_CONFIG_DIR, "opencode.json");
const CURRENT_PROFILE_PATH = path.join(OPENCODE_CONFIG_DIR, ".current-profile");

// This is only a same-render fallback used before the live profile list
// loads (see useOpencodeProfiles) — the real source of truth is
// ~/.config/opencode/.current-profile (getCurrentOpencodeProfile below).
// It WILL drift if profiles/ is reorganized by hand — that's what just
// broke session creation ("Unknown OpenCode profile: max" after `max.json`
// got archived and .current-profile moved to "deepseek-openrouter").
// Check `ls ~/.config/opencode/profiles` before trusting this literal.
export const DEFAULT_OPENCODE_PROFILE = "deepseek-openrouter";

export interface OpencodeProfile {
  id: string;
  name: string;
  description?: string;
}

// Friendly labels for the profiles this setup ships with, matching the
// descriptions in the `oc()` shell function. A profile file without an
// entry here still shows up (labeled with its own file name), so adding a
// new profiles/<id>.json file doesn't require a code change.
const PROFILE_DISPLAY_NAMES: Record<string, { name: string; description: string }> = {
  max: {
    name: "Max (default)",
    description: "OpenCode Go — grok-4.7 for everything, single best model available for now",
  },
  quality: {
    name: "Quality",
    description: "DeepSeek V4 Flash (paid) as main worker, GigaChat Ultra for planning",
  },
  value: {
    name: "Value",
    description: "Free-tier DeepSeek V4 Flash, paid endpoint only as fallback",
  },
  free: {
    name: "Free",
    description: "Free-tier models only (Nemotron) — never falls back to a paid model",
  },
  mimo: {
    name: "Mimo",
    description: "A/B test: Xiaomi MiMo V2.5 as the main coding model",
  },
  "russian-recruiter": {
    name: "Russian Recruiter",
    description: "GigaChat Pro/Ultra/Max — for interviews, transcripts and reports in Russian",
  },
  "lavish-luna": {
    name: "Lavish Luna",
    description: "OpenCode Zen models (GPT-5.6 Luna, Kimi K3, GLM, Qwen)",
  },
};

function titleCaseFromId(id: string): string {
  return id
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Lists profiles found in ~/.config/opencode/profiles. Empty if OpenCode isn't set up this way. */
export function listOpencodeProfiles(): OpencodeProfile[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(PROFILES_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  return files
    .map((file) => {
      const id = file.replace(/\.json$/, "");
      const known = PROFILE_DISPLAY_NAMES[id];
      return {
        id,
        name: known?.name ?? titleCaseFromId(id),
        description: known?.description,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Reads the currently active profile id from ~/.config/opencode/.current-profile.
 * Verifies the file it names actually still exists (profiles get renamed/archived
 * by hand) — falls back to DEFAULT_OPENCODE_PROFILE, and if even that's gone,
 * to whatever profile genuinely exists on disk, rather than pointing callers at
 * a dead profile id.
 */
export function getCurrentOpencodeProfile(): string {
  let candidate = DEFAULT_OPENCODE_PROFILE;
  try {
    const value = fs.readFileSync(CURRENT_PROFILE_PATH, "utf-8").trim();
    if (value) candidate = value;
  } catch {
    // No .current-profile file yet — use the default.
  }

  if (fs.existsSync(path.join(PROFILES_DIR, `${candidate}.json`))) return candidate;

  const anyExisting = listOpencodeProfiles()[0]?.id;
  return anyExisting ?? candidate;
}

/**
 * Deep-merges two parsed JSON values the way jq's `*` operator does: plain
 * objects are merged key by key (recursively), anything else (arrays,
 * strings, numbers, missing keys) is replaced by the override's value.
 */
function deepMergeJson(base: unknown, override: unknown): unknown {
  const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  if (isPlainObject(base) && isPlainObject(override)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, overrideValue] of Object.entries(override)) {
      merged[key] = key in merged ? deepMergeJson(merged[key], overrideValue) : overrideValue;
    }
    return merged;
  }

  return override;
}

/**
 * Applies an OpenCode profile the same way `oc <profile>` does in the shell:
 * merge base.json with profiles/<profileId>.json into opencode.json, and
 * record the active profile. Call this right before starting an `opencode`
 * process from the UI so it picks up the chosen profile's models —
 * including the per-role (build/plan/explore/general/review) model
 * overrides, which an `opencode run -m` flag alone cannot express.
 */
export function applyOpencodeProfile(profileId: string): void {
  let resolvedProfileId = profileId;
  let profilePath = path.join(PROFILES_DIR, `${profileId}.json`);

  // Profiles get renamed/archived by hand from time to time (see the
  // DEFAULT_OPENCODE_PROFILE comment above) — a stale client (an old tab,
  // a cached dropdown value) can still request a profile id that no longer
  // exists. Throwing here used to abort session creation entirely with no
  // terminal ever opening and no session_id ever coming back — from the UI
  // this looked like "nothing happened", not an error. Fall back to
  // whichever profile is actually live instead of hard-failing, and only
  // throw if THAT is also missing (a genuinely broken setup).
  if (!fs.existsSync(profilePath)) {
    const fallbackId = getCurrentOpencodeProfile();
    const fallbackPath = path.join(PROFILES_DIR, `${fallbackId}.json`);
    if (!fs.existsSync(fallbackPath)) {
      throw new Error(`Unknown OpenCode profile: ${profileId} (fallback "${fallbackId}" also missing)`);
    }
    console.warn(`[opencode-profiles] Unknown profile "${profileId}" requested — falling back to current "${fallbackId}"`);
    resolvedProfileId = fallbackId;
    profilePath = fallbackPath;
  }

  const profileConfig = JSON.parse(fs.readFileSync(profilePath, "utf-8"));

  let baseConfig: unknown = {};
  try {
    baseConfig = JSON.parse(fs.readFileSync(BASE_CONFIG_PATH, "utf-8"));
  } catch {
    // No base.json — merge the profile onto an empty config.
  }

  const mergedConfig = allowAttachmentDirectory(deepMergeJson(baseConfig, profileConfig));
  fs.writeFileSync(MERGED_CONFIG_PATH, JSON.stringify(mergedConfig, null, 2));
  fs.writeFileSync(CURRENT_PROFILE_PATH, resolvedProfileId);
}

/**
 * Files attached in the Session Manager UI (screenshots, pasted files, drag &
 * drop) are saved by /api/upload into <tmpdir>/session-drops — outside the
 * project directory. OpenCode treats that as an "external_directory" and asks
 * for permission; `opencode run` has nobody to answer, so it auto-rejects and
 * the agent can't read the attachment ("permission requested:
 * external_directory (...session-drops/*); auto-rejecting"). Allow reads of
 * exactly that folder, keeping any rules the user already configured.
 */
function allowAttachmentDirectory(config: unknown): unknown {
  const attachmentGlob = `${path.join(os.tmpdir(), "session-drops")}/*`;
  const root = (typeof config === "object" && config !== null ? config : {}) as Record<string, unknown>;
  const permission = root.permission;

  // A blanket string action (e.g. "allow") already covers everything — leave it.
  if (typeof permission === "string") return root;

  const permissionRules = (typeof permission === "object" && permission !== null ? permission : {}) as Record<string, unknown>;
  const externalRule = permissionRules.external_directory;
  if (typeof externalRule === "string") return root;

  const externalRules = (typeof externalRule === "object" && externalRule !== null ? externalRule : {}) as Record<string, unknown>;
  return {
    ...root,
    permission: {
      ...permissionRules,
      external_directory: { ...externalRules, [attachmentGlob]: "allow" },
    },
  };
}
