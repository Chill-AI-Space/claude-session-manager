import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const isWin = process.platform === "win32";

let _opencodePath: string | null = null;

export function getOpencodePath(): string {
  if (_opencodePath) return _opencodePath;

  const candidates = isWin
    ? []
    : [
        path.join(os.homedir(), ".opencode", "bin", "opencode"),
        path.join(os.homedir(), ".local", "bin", "opencode"),
        "/usr/local/bin/opencode",
        "/opt/homebrew/bin/opencode",
      ];

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        _opencodePath = c;
        return _opencodePath;
      }
    } catch { /* try next */ }
  }

  try {
    const cmd = isWin ? "where" : "which";
    const result = execFileSync(cmd, ["opencode"], {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    const resolved = result.split(/\r?\n/)[0];
    if (resolved && fs.existsSync(resolved)) {
      _opencodePath = resolved;
      return _opencodePath;
    }
  } catch { /* not in PATH */ }

  _opencodePath = "opencode";
  return _opencodePath;
}
