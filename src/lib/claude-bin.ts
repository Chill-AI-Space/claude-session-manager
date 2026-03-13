/**
 * Resolve the full path to the `claude` binary (server-only).
 * Cached after first lookup. Needed because launchd doesn't load shell aliases,
 * and shell:true causes argument injection when messages contain special chars.
 */
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const isWin = process.platform === "win32";

let _claudePath: string | null = null;

export function getClaudePath(): string {
  if (_claudePath) return _claudePath;
  try {
    // Use shell to resolve PATH (one-time at startup, no user input)
    const cmd = isWin ? "where claude" : "which claude";
    const result = execSync(cmd, { encoding: "utf-8", timeout: 5000 }).trim();
    // `where` on Windows may return multiple lines — take the first
    _claudePath = result.split(/\r?\n/)[0];
  } catch {
    // Fallback to common locations
    const candidates = isWin
      ? [
          path.join(os.homedir(), ".local", "bin", "claude.exe"),
          path.join(os.homedir(), "AppData", "Local", "Programs", "claude", "claude.exe"),
          path.join(os.homedir(), "AppData", "Local", "Microsoft", "WinGet", "Links", "claude.exe"),
          path.join(os.homedir(), ".claude", "bin", "claude.exe"),
        ]
      : [
          path.join(os.homedir(), ".local", "bin", "claude"),
          "/usr/local/bin/claude",
          "/opt/homebrew/bin/claude",
        ];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) {
          _claudePath = c;
          return _claudePath;
        }
      } catch { /* try next */ }
    }
    _claudePath = "claude"; // last resort — rely on PATH
  }
  return _claudePath;
}
