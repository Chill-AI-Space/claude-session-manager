import fs from "fs";
import os from "os";
import path from "path";

/**
 * Codex model list.
 *
 * The Codex CLI keeps the models it is currently allowed to run in
 * ~/.codex/models_cache.json — a cache it refreshes from OpenAI's model
 * endpoint, containing slugs, display names, descriptions and ordering
 * (`priority`, 1 = what Codex picks by default). Reading it is the only way to
 * get a list that doesn't rot: this setup's account sees GPT-6.x models
 * (gpt-6.1-sol, gpt-6-astra, gpt-6-luna, gpt-5.6-terra, ...), which replaced
 * the gpt-5.4 / gpt-4o ids that used to be hardcoded in the UI dropdown — those
 * now fail with an unknown-model error when passed to `codex exec`.
 *
 * Same shape as src/lib/opencode-profiles.ts: a filesystem-backed list served
 * over an API route, with a static fallback so the dropdown still renders if
 * Codex has never been run (no cache file) or the file is unreadable.
 */

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const MODELS_CACHE_PATH = path.join(CODEX_HOME, "models_cache.json");

export interface CodexModel {
  slug: string;
  displayName: string;
  description?: string;
}

/**
 * Used only when ~/.codex/models_cache.json is missing or malformed — i.e.
 * Codex isn't installed / has never run, or its cache format changed. Mirrors
 * the list as of codex-cli 0.160.0 (2026-10-05); a live cache always wins, so
 * this does NOT need to be updated when OpenAI ships new models.
 */
const FALLBACK_MODELS: CodexModel[] = [
  { slug: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", description: "Latest workhorse model for coding and everyday work." },
  { slug: "gpt-6-astra", displayName: "GPT-6-Astra", description: "Frontier intelligence for the most demanding work." },
  { slug: "gpt-6-sol", displayName: "GPT-6-Sol", description: "Previous generation workhorse model." },
  { slug: "gpt-6-luna", displayName: "GPT-6-Luna", description: "Fast and affordable model for easier tasks." },
  { slug: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", description: "Older generation workhorse model." },
  { slug: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", description: "Older balanced model for straightforward work." },
  { slug: "gpt-5.6-luna", displayName: "GPT-5.6-Luna", description: "Older fast and efficient model." },
  { slug: "gpt-5.5", displayName: "GPT-5.5", description: "Legacy coding model." },
];

/** Only the first entry of the cache is what Codex itself defaults to. */
export const DEFAULT_CODEX_MODEL = FALLBACK_MODELS[0].slug;

interface CacheModel {
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  visibility?: unknown;
  priority?: unknown;
}

/**
 * Lists the models this Codex install can run, newest/most capable first.
 *
 * Filters on `visibility: "list"` — the cache also carries models the CLI
 * keeps to itself (`gpt-reserve`, `codex-auto-review`), which aren't offered
 * as user-selectable models. Sorts by `priority` so the order matches the
 * CLI's own model picker (1 = default, ascending).
 */
export function listCodexModels(): CodexModel[] {
  let cache: { models?: CacheModel[] };
  try {
    cache = JSON.parse(fs.readFileSync(MODELS_CACHE_PATH, "utf-8"));
  } catch {
    // No cache yet (Codex never ran / not installed) or unparseable.
    return FALLBACK_MODELS;
  }

  const cached = cache.models;
  if (!Array.isArray(cached)) return FALLBACK_MODELS;

  const models = cached
    .filter((model): model is CacheModel & { slug: string } => typeof model.slug === "string" && model.slug !== "")
    .filter((model) => model.visibility === "list")
    .map((model) => ({
      slug: model.slug,
      displayName: typeof model.display_name === "string" ? model.display_name : model.slug,
      description: typeof model.description === "string" ? model.description : undefined,
    }))
    .sort((a, b) => priorityOf(cached, a.slug) - priorityOf(cached, b.slug));

  // A cache that parses but yields nothing usable is as good as no cache.
  return models.length > 0 ? models : FALLBACK_MODELS;
}

function priorityOf(models: CacheModel[], slug: string): number {
  const priority = models.find((model) => model.slug === slug)?.priority;
  return typeof priority === "number" ? priority : Number.MAX_SAFE_INTEGER;
}