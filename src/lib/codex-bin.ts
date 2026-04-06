/**
 * Resolve the full path to the `codex` binary (server-only).
 * Cached after first lookup, mirrors forge-bin.ts pattern.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const isWin = process.platform === "win32";

let _codexPath: string | null = null;

export function getCodexPath(): string {
  if (_codexPath) return _codexPath;

  const candidates = isWin
    ? [
        path.join(os.homedir(), "AppData", "Local", "Programs", "codex", "codex.exe"),
        path.join(os.homedir(), ".local", "bin", "codex.exe"),
      ]
    : [
        // nvm global bin (most common on macOS)
        path.join(os.homedir(), ".nvm", "versions", "node", "v24.13.0", "bin", "codex"),
        path.join(os.homedir(), ".nvm", "versions", "node", "v22.0.0", "bin", "codex"),
        path.join(os.homedir(), ".local", "bin", "codex"),
        "/usr/local/bin/codex",
        "/opt/homebrew/bin/codex",
      ];

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        _codexPath = c;
        return _codexPath;
      }
    } catch { /* try next */ }
  }

  try {
    const cmd = isWin ? "where" : "which";
    const result = execFileSync(cmd, ["codex"], {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    const resolved = result.split(/\r?\n/)[0];
    if (resolved && fs.existsSync(resolved)) {
      _codexPath = resolved;
      return _codexPath;
    }
  } catch { /* not in PATH */ }

  _codexPath = "codex";
  return _codexPath;
}
