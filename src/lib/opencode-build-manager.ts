import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Server-side bridge to the mem-builds.sh build manager. The script owns the
 * on-disk layout (~/.opencode/builds), the "current"/"previous" symlinks and
 * the registration of the builds in this app's settings. This module only
 * locates it, runs a whitelisted command and parses the state it reports.
 */

export interface ManagedBuild {
  sha: string;
  version: string;
  installed: boolean;
  queued: boolean;
}

export interface ManagedBuildState {
  dir: string;
  current: string | null;
  previous: string | null;
  builds: ManagedBuild[];
}

/** Locations are checked in order; the env var wins so tests and custom installs can point elsewhere. */
function scriptCandidates(): string[] {
  return [
    process.env.MEM_BUILDS_SCRIPT,
    path.join(os.homedir(), "opencode-mem-architecture", "chain", "mem-builds.sh"),
    path.join(os.homedir(), ".opencode", "scripts", "mem-builds.sh"),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

/** Absolute path to the build manager, or null when it is not installed. */
export function findBuildManagerScript(): string | null {
  for (const candidate of scriptCandidates()) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * A failing child process carries the useful text in stderr/stdout, not in the
 * "Command failed: …" message. Exported so it can be tested without a throwing mock.
 */
export function describeExecError(error: unknown): string {
  if (typeof error === "string") return error.trim();
  if (Buffer.isBuffer(error)) return error.toString().trim();
  const e = error as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
  const text = e?.stderr || e?.stdout || e?.message || "build manager failed";
  return String(text).trim();
}

function run(args: string[], timeout = 10 * 60_000): string {
  const script = findBuildManagerScript();
  if (!script) throw new Error("Build manager not found (mem-builds.sh). Set MEM_BUILDS_SCRIPT or install it at ~/.opencode/scripts/mem-builds.sh");
  try {
    return execFileSync(script, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(describeExecError(error));
  }
}

export function readBuildState(): ManagedBuildState {
  const raw = run(["list", "--json"], 30_000);
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") throw new Error("Build manager returned no state");
  const state = parsed as ManagedBuildState;
  if (!Array.isArray(state.builds)) throw new Error("Build manager returned no build list");
  return state;
}

/** Install a locally built binary as the newest build and shift the pointers. */
export function installBuild(binary: string): string {
  if (!path.isAbsolute(binary)) throw new Error("Binary path must be absolute");
  if (!fs.existsSync(binary)) throw new Error(`No such binary: ${binary}`);
  if (!fs.statSync(binary).isFile()) throw new Error(`Not a file: ${binary}`);
  return run(["install", binary]);
}

/** Point "current"/"previous" at an already installed build. */
export function shiftBuild(sha: string): string {
  if (!/^[0-9a-fA-F]{7,40}$/.test(sha)) throw new Error(`Invalid build SHA: ${sha}`);
  return run(["shift", sha], 60_000);
}

/** Move "current" one step back in the build queue. */
export function rollbackBuild(): string {
  return run(["rollback"], 60_000);
}
