import fs from "fs";
import path from "path";
import { getSetting } from "@/lib/db";
import { getOpencodePath } from "@/lib/opencode-bin";

export interface OpencodeBuild {
  id: string;
  name: string;
  binary: string;
  kind: "upstream" | "stable" | "snapshot";
  builtAt?: string;
  branch?: string;
  commit?: string;
  pullRequest?: string;
  description?: string;
  autoFlag?: boolean;
}

/** Paths are server configuration, never executable commands supplied by a start request. */
export function parseOpencodeBuilds(raw: string): OpencodeBuild[] {
  const entries: unknown = JSON.parse(raw || "[]");
  if (!Array.isArray(entries)) throw new Error("opencode_builds must be a JSON array");
  const ids = new Set<string>();
  return entries.map((entry) => {
    const b = entry as OpencodeBuild;
    if (!b || typeof b.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(b.id) || ids.has(b.id)
      || typeof b.name !== "string" || !b.name.trim()
      || typeof b.binary !== "string" || !path.isAbsolute(b.binary)
      || !["upstream", "stable", "snapshot"].includes(b.kind)) {
      throw new Error("Invalid OpenCode build: unique id, name, absolute binary path and kind required");
    }
    for (const key of ["builtAt", "branch", "commit", "pullRequest", "description"] as const) {
      if (b[key] !== undefined && typeof b[key] !== "string") throw new Error(`Invalid build ${key}`);
    }
    if (b.builtAt && !Number.isFinite(Date.parse(b.builtAt))) throw new Error("Invalid build date");
    if (b.autoFlag !== undefined && typeof b.autoFlag !== "boolean") throw new Error("Invalid autoFlag");
    ids.add(b.id);
    return b;
  }).sort((a, b) => {
    const rank = { upstream: 0, stable: 1, snapshot: 2 };
    return rank[a.kind] - rank[b.kind] || (Date.parse(b.builtAt || "") || 0) - (Date.parse(a.builtAt || "") || 0);
  });
}

export function getOpencodeBuilds(): OpencodeBuild[] {
  return parseOpencodeBuilds(getSetting("opencode_builds"));
}

export function resolveOpencodeBuild(id?: string | null): { binary: string; autoFlag: boolean } {
  if (!id) return { binary: getOpencodePath(), autoFlag: true };
  const build = getOpencodeBuilds().find((b) => b.id === id);
  if (!build) throw new Error(`Unknown OpenCode build: ${id}`);
  try {
    if (!fs.statSync(build.binary).isFile()) throw new Error("not a file");
    fs.accessSync(build.binary, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
  } catch {
    throw new Error(`OpenCode build unavailable: ${build.name} (${build.binary})`);
  }
  return { binary: build.binary, autoFlag: build.autoFlag ?? build.kind !== "upstream" };
}
