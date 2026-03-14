/**
 * Resolve the full path to the `claude` binary (server-only).
 * Cached after first lookup. Needed because launchd doesn't load shell aliases,
 * and shell:true causes argument injection when messages contain special chars.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const isWin = process.platform === "win32";

let _claudePath: string | null = null;

export function getClaudePath(): string {
  if (_claudePath) return _claudePath;

  // Check known candidate paths FIRST using os.homedir() which handles
  // Unicode/Cyrillic usernames correctly on all platforms.
  // On Windows, `where` corrupts non-ASCII paths due to OEM codepage issues.
  const candidates = isWin
    ? [
        path.join(os.homedir(), ".local", "bin", "claude.exe"),
        path.join(os.homedir(), "AppData", "Local", "Programs", "claude", "claude.exe"),
        path.join(os.homedir(), "AppData", "Local", "Microsoft", "WinGet", "Links", "claude.exe"),
        path.join(os.homedir(), ".claude", "bin", "claude.exe"),
        // npm global installs
        path.join(os.homedir(), "AppData", "Roaming", "npm", "claude.cmd"),
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

  // Fall back to which/where for non-standard install locations.
  // On Windows with non-ASCII usernames this may return garbled paths,
  // so we validate with existsSync before trusting it.
  try {
    const cmd = isWin ? "where" : "which";
    const result = execFileSync(cmd, ["claude"], {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    const resolved = result.split(/\r?\n/)[0];

    if (resolved && fs.existsSync(resolved)) {
      _claudePath = resolved;
      return _claudePath;
    }
  } catch { /* not in PATH */ }

  _claudePath = "claude"; // last resort — rely on PATH
  return _claudePath;
}
