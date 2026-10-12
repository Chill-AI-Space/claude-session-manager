import fs from "fs";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const generatedConfigs: string[] = [];

const LIVE_PROFILES: Record<string, unknown> = {
  standard: {
    model: "ladder/standard",
    agent: { build: { model: "ladder/standard" } },
  },
  fast: {
    model: "ladder/fast",
    agent: { build: { model: "ladder/fast" } },
  },
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
  setCurrentProfile("standard");
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

afterEach(() => {
  for (const configPath of generatedConfigs.splice(0)) fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
});

function apply(id: string, remember = true) {
  const configPath = applyOpencodeProfile(id, remember);
  generatedConfigs.push(configPath);
  return configPath;
}

describe("listOpencodeProfiles", () => {
  it("lists exactly the three public modes while preserving legacy files", () => {
    const profiles = listOpencodeProfiles();

    expect(profiles.map((p) => p.id)).toEqual(["standard", "free", "fast"]);
    expect(profiles.find((p) => p.id === "standard")).toEqual({
      id: "standard",
      name: "Standard",
      description: "Экономный режим с платным резервом после бесплатных моделей",
    });
    expect(profiles.find((p) => p.id === "free")?.name).toBe("Free");
    expect(profiles.find((p) => p.id === "fast")?.name).toBe("Fast");
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
    setCurrentProfile("fast");
    expect(getCurrentOpencodeProfile()).toBe("fast");
  });

  it("falls back to standard when .current-profile points at a non-existent profile", () => {
    setCurrentProfile("deepseek-go");
    expect(getCurrentOpencodeProfile()).toBe("standard");
  });

  it("falls back to standard when .current-profile is missing", () => {
    setCurrentProfile(null);
    expect(getCurrentOpencodeProfile()).toBe("standard");
  });

  it("falls back to standard when .current-profile is empty", () => {
    setCurrentProfile("");
    expect(getCurrentOpencodeProfile()).toBe("standard");
  });

  it("uses the public default for new sessions while legacy profiles remain explicit", () => {
    setCurrentProfile("master");
    expect(getCurrentOpencodeProfile()).toBe("standard");
  });

  it("does not switch to a different budget when standard is missing", () => {
    fs.rmSync(path.join(PROFILES_DIR, "standard.json"));
    setCurrentProfile("master");
    expect(getCurrentOpencodeProfile()).toBe("standard");
  });
});

describe("applyOpencodeProfile", () => {
  it("deep-merges a legacy profile into a private config without changing the global file", () => {
    const configPath = apply("phd");

    expect(fs.readFileSync(CURRENT_PROFILE_PATH, "utf-8")).toBe("standard");
    expect(fs.existsSync(path.join(CONFIG_DIR, "opencode.json"))).toBe(false);
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);

    const merged = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    // Profile override wins for build, base keys survive elsewhere.
    expect(merged.model).toBe("ladder/build advanced");
    expect(merged.theme).toBe("dark");
    expect(merged.agent.build.model).toBe("ladder/build advanced");
    expect(merged.agent.plan.model).toBe("opencode-go/base-plan");
  });

  it("remembers the last selection: a later getCurrentOpencodeProfile returns it", () => {
    apply("fast");
    expect(getCurrentOpencodeProfile()).toBe("fast");

    apply("free");
    expect(getCurrentOpencodeProfile()).toBe("free");
  });

  it("rejects unknown ids rather than silently changing the budget", () => {
    setCurrentProfile("standard");
    expect(() => applyOpencodeProfile("deepseek-go")).toThrow("Unknown OpenCode profile");
    expect(() => applyOpencodeProfile("../free")).toThrow("Unknown OpenCode profile");
    expect(fs.readFileSync(CURRENT_PROFILE_PATH, "utf-8")).toBe("standard");
  });

  it("resumes with the chosen profile without changing the default selection", () => {
    const configPath = apply("fast", false);
    expect(JSON.parse(fs.readFileSync(configPath, "utf-8")).model).toBe("ladder/fast");
    expect(getCurrentOpencodeProfile()).toBe("standard");
  });
});
