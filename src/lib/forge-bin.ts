/**
 * Resolve the full path to the `forge` binary (server-only).
 * Cached after first lookup, mirrors claude-bin.ts pattern.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const isWin = process.platform === "win32";

let _forgePath: string | null = null;

export function getForgePath(): string {
  if (_forgePath) return _forgePath;

  const candidates = isWin
    ? [
        path.join(os.homedir(), ".local", "bin", "forge.exe"),
        path.join(os.homedir(), "AppData", "Local", "Programs", "forge", "forge.exe"),
      ]
    : [
        path.join(os.homedir(), ".local", "bin", "forge"),
        "/usr/local/bin/forge",
        "/opt/homebrew/bin/forge",
      ];

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        _forgePath = c;
        return _forgePath;
      }
    } catch { /* try next */ }
  }

  try {
    const cmd = isWin ? "where" : "which";
    const result = execFileSync(cmd, ["forge"], {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    const resolved = result.split(/\r?\n/)[0];
    if (resolved && fs.existsSync(resolved)) {
      _forgePath = resolved;
      return _forgePath;
    }
  } catch { /* not in PATH */ }

  _forgePath = "forge";
  return _forgePath;
}
