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
const CURRENT_PROFILE_PATH = path.join(OPENCODE_CONFIG_DIR, ".current-profile");

// Public Ladder modes. Legacy profile files remain usable by existing sessions
// and explicit callers, but are not offered for new sessions.
const PUBLIC_OPENCODE_PROFILES = ["standard", "free", "fast"] as const;
export const DEFAULT_OPENCODE_PROFILE = "standard";

export interface OpencodeProfile {
  id: string;
  name: string;
  description?: string;
}

const PROFILE_DISPLAY_NAMES: Record<(typeof PUBLIC_OPENCODE_PROFILES)[number], { name: string; description: string }> = {
  standard: {
    name: "Standard",
    description: "Экономный режим с платным резервом после бесплатных моделей",
  },
  fast: {
    name: "Fast",
    description: "Быстрый платный старт, кэш и платный резерв",
  },
  free: {
    name: "Free",
    description: "Только бесплатные модели, без платного резерва",
  },
};

/** Lists the three public modes when their profile files are installed. */
export function listOpencodeProfiles(): OpencodeProfile[] {
  return PUBLIC_OPENCODE_PROFILES
    .filter((id) => fs.existsSync(path.join(PROFILES_DIR, `${id}.json`)))
    .map((id) => {
      return { id, ...PROFILE_DISPLAY_NAMES[id] };
    })
}

/**
 * Reads the currently active profile id from ~/.config/opencode/.current-profile.
 * Returns a public mode if installed. A legacy current profile remains on disk
 * for explicit use, but new sessions default to standard.
 */
export function getCurrentOpencodeProfile(): string {
  let candidate = DEFAULT_OPENCODE_PROFILE;
  try {
    const value = fs.readFileSync(CURRENT_PROFILE_PATH, "utf-8").trim();
    if (value) candidate = value;
  } catch {
    // No .current-profile file yet — use the default.
  }

  if (
    PUBLIC_OPENCODE_PROFILES.some((id) => id === candidate) &&
    fs.existsSync(path.join(PROFILES_DIR, `${candidate}.json`))
  ) return candidate;

  // Unknown and legacy selections never become a different paid mode by
  // alphabetical accident.
  if (fs.existsSync(path.join(PROFILES_DIR, `${DEFAULT_OPENCODE_PROFILE}.json`))) {
    return DEFAULT_OPENCODE_PROFILE;
  }

  return DEFAULT_OPENCODE_PROFILE;
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

/** Validates a profile id before using it as a filename. */
export function hasOpencodeProfile(profileId: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(profileId) && fs.existsSync(path.join(PROFILES_DIR, `${profileId}.json`));
}

/** Writes one private config file for a single OpenCode process. */
export function applyOpencodeProfile(profileId: string, remember = true): string {
  if (!hasOpencodeProfile(profileId)) throw new Error(`Unknown OpenCode profile: ${profileId}`);
  const profilePath = path.join(PROFILES_DIR, `${profileId}.json`);

  const profileConfig = JSON.parse(fs.readFileSync(profilePath, "utf-8"));

  let baseConfig: unknown = {};
  try {
    baseConfig = JSON.parse(fs.readFileSync(BASE_CONFIG_PATH, "utf-8"));
  } catch {
    // No base.json — merge the profile onto an empty config.
  }

  const mergedConfig = allowAttachmentDirectory(deepMergeJson(baseConfig, profileConfig));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "csm-opencode-config-"));
  fs.chmodSync(directory, 0o700);
  const configPath = path.join(directory, "opencode.json");
  fs.writeFileSync(configPath, JSON.stringify(mergedConfig), { mode: 0o600 });
  if (remember && PUBLIC_OPENCODE_PROFILES.some((id) => id === profileId)) {
    fs.writeFileSync(CURRENT_PROFILE_PATH, profileId);
  }
  return configPath;
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
