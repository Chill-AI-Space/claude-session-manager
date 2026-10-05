import fs from "fs";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// codex-models.ts resolves ~/.codex at module load time, so the homedir mock and
// the sandbox dir must exist before the module is imported (same pattern as
// opencode-profiles.test.ts). The sandbox path is created inside the (async)
// mock factory and shared via this holder — vi.hoisted can't use the fs/path
// imports directly.
const sandbox = vi.hoisted(() => ({ tmpRoot: "" }));
vi.mock("os", async () => {
  const fs = await import("fs");
  const path = await import("path");
  const realTmpdir = fs.realpathSync("/tmp");
  sandbox.tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(realTmpdir, "codex-models-test-")));
  return {
    default: { homedir: () => sandbox.tmpRoot, tmpdir: () => realTmpdir },
    homedir: () => sandbox.tmpRoot,
    tmpdir: () => realTmpdir,
  };
});
const tmpRoot = sandbox.tmpRoot;

import { DEFAULT_CODEX_MODEL, listCodexModels } from "../codex-models";

const CODEX_DIR = path.join(tmpRoot, ".codex");
const CACHE_PATH = path.join(CODEX_DIR, "models_cache.json");

/** Shaped like a real cache entry; only the fields listCodexModels reads. */
function cacheEntry(slug: string, displayName: string, priority: number, visibility = "list") {
  return {
    slug,
    display_name: displayName,
    description: `${displayName} description`,
    visibility,
    priority,
    default_reasoning_level: "medium",
    supported_reasoning_levels: [{ effort: "medium" }],
  };
}

function writeCache(models: unknown[]) {
  fs.mkdirSync(CODEX_DIR, { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify({ fetched_at: "2026-10-05T00:00:00Z", models }));
}

describe("listCodexModels", () => {
  beforeEach(() => {
    fs.rmSync(CODEX_DIR, { recursive: true, force: true });
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("lists the models from Codex's cache, most capable first by priority", () => {
    writeCache([
      cacheEntry("gpt-6-luna", "GPT-6-Luna", 4),
      cacheEntry("gpt-6.1-sol", "GPT-6.1-Sol", 1),
      cacheEntry("gpt-6-astra", "GPT-6-Astra", 2),
      cacheEntry("gpt-6-sol", "GPT-6-Sol", 3),
    ]);

    expect(listCodexModels().map((m) => m.slug)).toEqual([
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
    ]);
  });

  it("keeps the cache's display name and description", () => {
    writeCache([cacheEntry("gpt-6.1-sol", "GPT-6.1-Sol", 1)]);

    expect(listCodexModels()).toEqual([
      { slug: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", description: "GPT-6.1-Sol description" },
    ]);
  });

  it("hides models the CLI doesn't offer as user-selectable", () => {
    writeCache([
      cacheEntry("gpt-6.1-sol", "GPT-6.1-Sol", 1),
      cacheEntry("gpt-reserve", "GPT-Reserve", 4, "hide"),
      cacheEntry("codex-auto-review", "Codex Auto Review", 43, "hide"),
    ]);

    expect(listCodexModels().map((m) => m.slug)).toEqual(["gpt-6.1-sol"]);
  });

  it("falls back to a static list when Codex has no cache yet", () => {
    const models = listCodexModels();

    expect(models.length).toBeGreaterThan(0);
    // First entry is what the UI preselects before the fetch resolves.
    expect(models[0].slug).toBe(DEFAULT_CODEX_MODEL);
    expect(DEFAULT_CODEX_MODEL).toBe("gpt-6.1-sol");
  });

  it("falls back to a static list when the cache is corrupt or unusable", () => {
    fs.mkdirSync(CODEX_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, "{ not json");
    expect(listCodexModels()[0].slug).toBe(DEFAULT_CODEX_MODEL);

    fs.writeFileSync(CACHE_PATH, JSON.stringify({ models: [] }));
    expect(listCodexModels()[0].slug).toBe(DEFAULT_CODEX_MODEL);

    fs.writeFileSync(CACHE_PATH, JSON.stringify({ models: [{ visibility: "list" }] }));
    expect(listCodexModels()[0].slug).toBe(DEFAULT_CODEX_MODEL);
  });
});