import fs from "fs";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// opencode-profiles.ts resolves ~/.config/opencode at module load time, so the
// homedir mock and the sandbox dir must exist before the module is imported.
// The sandbox path is created inside the (async) mock factory and shared via
// this holder — vi.hoisted can't use the fs/path imports directly.
const sandbox = vi.hoisted(() => ({ tmpRoot: "" }));
vi.mock("os", async () => {
  const fs = await import("fs");
  const path = await import("path");
  const realTmpdir = fs.realpathSync("/tmp");
  sandbox.tmpRoot = fs.mkdtempSync(path.join(realTmpdir, "opencode-profiles-test-"));
  return {
    default: { homedir: () => sandbox.tmpRoot, tmpdir: () => realTmpdir },
    homedir: () => sandbox.tmpRoot,
    tmpdir: () => realTmpdir,
  };
});
const tmpRoot = sandbox.tmpRoot;

import { applyOpencodeProfile, getCurrentOpencodeProfile, listOpencodeProfiles } from "../opencode-profiles";

const CONFIG_DIR = path.join(tmpRoot, ".config", "opencode");
const PROFILES_DIR = path.join(CONFIG_DIR, "profiles");
const CURRENT_PROFILE_PATH = path.join(CONFIG_DIR, ".current-profile");

const LIVE_PROFILES: Record<string, unknown> = {
  master: {
    model: "ladder/build",
    agent: {
      build: { model: "ladder/build" },
      plan: { model: "ladder/plan" },
      explore: { model: "ladder/explore" },
      general: { model: "ladder/general" },
      review: { model: "ladder/review" },
    },
  },
  phd: {
    model: "ladder/build advanced",
    agent: { build: { model: "ladder/build advanced" } },
  },
  free: {
    model: "ladder/free",
    agent: { build: { model: "ladder/free" } },
  },
  "ladder-research": {
    model: "ladder/research",
    agent: { build: { model: "ladder/research" } },
  },
  "russian-recruiter": {
    model: "opencode-go/deepseek-v4.1-flash",
    agent: { build: { model: "opencode-go/deepseek-v4.1-flash" } },
  },
};

const BASE_CONFIG = {
  model: "opencode-go/some-default",
  theme: "dark",
  agent: {
    build: { model: "opencode-go/base-build" },
    plan: { model: "opencode-go/base-plan" },
  },
};

function writeProfile(id: string, config: unknown) {
  fs.writeFileSync(path.join(PROFILES_DIR, `${id}.json`), JSON.stringify(config, null, 2));
}

function setCurrentProfile(value: string | null) {
  if (value === null) {
    fs.rmSync(CURRENT_PROFILE_PATH, { force: true });
  } else {
    fs.writeFileSync(CURRENT_PROFILE_PATH, value);
  }
}

beforeEach(() => {
  fs.rmSync(PROFILES_DIR, { recursive: true, force: true });
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  fs.writeFileSync(path.join(CONFIG_DIR, "base.json"), JSON.stringify(BASE_CONFIG, null, 2));
  for (const [id, config] of Object.entries(LIVE_PROFILES)) {
    writeProfile(id, config);
  }
  setCurrentProfile("master");
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("listOpencodeProfiles", () => {
  it("lists exactly the live profiles with display names and descriptions", () => {
    const profiles = listOpencodeProfiles();

    expect(profiles.map((p) => p.id)).toEqual([
      "free",
      "ladder-research",
      "master",
      "phd",
      "russian-recruiter",
    ]);
    expect(profiles.find((p) => p.id === "master")).toEqual({
      id: "master",
      name: "Master",
      description: "Дефолт: build на ladder/build, остальные роли — соседние ступени лестницы",
    });
    expect(profiles.find((p) => p.id === "phd")?.name).toBe("PhD");
    expect(profiles.find((p) => p.id === "free")?.name).toBe("Free");
    expect(profiles.find((p) => p.id === "ladder-research")?.name).toBe("Ladder Research");
    expect(profiles.find((p) => p.id === "russian-recruiter")?.name).toBe("Russian Recruiter");
  });

  it("does not list archived profiles (moved to profiles/_archive)", () => {
    fs.mkdirSync(path.join(PROFILES_DIR, "_archive"));
    writeProfile("_archive/deepseek-go", LIVE_PROFILES.master);
    writeProfile("_archive/quality", LIVE_PROFILES.master);

    expect(listOpencodeProfiles().map((p) => p.id)).not.toContain("deepseek-go");
    expect(listOpencodeProfiles().map((p) => p.id)).not.toContain("quality");
  });
});

describe("getCurrentOpencodeProfile", () => {
  it("returns the profile recorded in .current-profile", () => {
    setCurrentProfile("phd");
    expect(getCurrentOpencodeProfile()).toBe("phd");
  });

  it("falls back to master when .current-profile points at a non-existent profile", () => {
    setCurrentProfile("deepseek-go");
    expect(getCurrentOpencodeProfile()).toBe("master");
  });

  it("falls back to master when .current-profile is missing", () => {
    setCurrentProfile(null);
    expect(getCurrentOpencodeProfile()).toBe("master");
  });

  it("falls back to master when .current-profile is empty", () => {
    setCurrentProfile("");
    expect(getCurrentOpencodeProfile()).toBe("master");
  });
});

describe("applyOpencodeProfile", () => {
  it("deep-merges base.json with the profile and records it as current", () => {
    applyOpencodeProfile("phd");

    expect(fs.readFileSync(CURRENT_PROFILE_PATH, "utf-8")).toBe("phd");

    const merged = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "opencode.json"), "utf-8"));
    // Profile override wins for build, base keys survive elsewhere.
    expect(merged.model).toBe("ladder/build advanced");
    expect(merged.theme).toBe("dark");
    expect(merged.agent.build.model).toBe("ladder/build advanced");
    expect(merged.agent.plan.model).toBe("opencode-go/base-plan");
  });

  it("remembers the last selection: a later getCurrentOpencodeProfile returns it", () => {
    applyOpencodeProfile("phd");
    expect(getCurrentOpencodeProfile()).toBe("phd");

    applyOpencodeProfile("free");
    expect(getCurrentOpencodeProfile()).toBe("free");
  });

  it("falls back to the current profile (master) for an unknown id instead of throwing", () => {
    setCurrentProfile("master");
    applyOpencodeProfile("deepseek-go");

    expect(fs.readFileSync(CURRENT_PROFILE_PATH, "utf-8")).toBe("master");
    const merged = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "opencode.json"), "utf-8"));
    expect(merged.model).toBe("ladder/build");
  });
});
