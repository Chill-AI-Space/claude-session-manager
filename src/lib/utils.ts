import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import os from "os"
import path from "path"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Cross-platform home directory (works on Windows, macOS, Linux) */
export function homeDir(): string {
  return os.homedir();
}

/** Cross-platform path to Claude projects directory */
export function claudeProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/**
 * Get the last segment(s) of a path, cross-platform.
 * Works with both `/` and `\` separators.
 * `segments` controls how many trailing parts to keep (default 1 = basename).
 */
export function pathTail(p: string, segments = 1): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.slice(-segments).join("/");
}

/**
 * Resolve `~` to home directory, cross-platform.
 */
export function expandTilde(p: string): string {
  return p.replace(/^~(?=[\\/]|$)/, os.homedir());
}

/**
 * Collapse home directory prefix to `~` for display.
 */
export function collapseTilde(p: string): string {
  const home = os.homedir();
  if (p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toString();
}

/** Whether to pass shell:true to spawn() — needed on Windows for .cmd/.bat resolution */
export const SPAWN_SHELL = process.platform === "win32";

/** Strip CLAUDE* env vars to avoid interfering with spawned processes */
export function getCleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE")) delete env[key];
  }
  return env;
}
