import fs from "fs";
import path from "path";
import os from "os";
import { getSetting } from "./db";

const ARCHIVE_DIR = path.join(
  os.homedir(),
  ".config",
  "claude-session-manager",
  "archive"
);

/** Ensure archive subdirectory exists for a project. */
function ensureDir(projectDir: string): string {
  const dir = path.join(ARCHIVE_DIR, projectDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Copy a JSONL file to the archive. Skips if archive copy is already up-to-date. */
export function archiveSession(
  jsonlPath: string,
  sessionId: string,
  projectDir: string
): boolean {
  try {
    if (!fs.existsSync(jsonlPath)) return false;

    const archiveDir = ensureDir(projectDir);
    const dest = path.join(archiveDir, `${sessionId}.jsonl`);

    const srcStat = fs.statSync(jsonlPath);

    // Skip if archive copy exists and is same size or newer
    if (fs.existsSync(dest)) {
      const destStat = fs.statSync(dest);
      if (destStat.mtimeMs >= srcStat.mtimeMs && destStat.size === srcStat.size) {
        return false; // already up-to-date
      }
    }

    fs.copyFileSync(jsonlPath, dest);
    // Preserve original mtime
    fs.utimesSync(dest, srcStat.atime, srcStat.mtime);
    return true;
  } catch {
    return false;
  }
}

/** Get the archive path for a session, or null if not archived. */
export function getArchivePath(
  sessionId: string,
  projectDir: string
): string | null {
  const dest = path.join(ARCHIVE_DIR, projectDir, `${sessionId}.jsonl`);
  return fs.existsSync(dest) ? dest : null;
}

/** Remove archived files older than ttlDays. Returns count of deleted files. */
export function cleanupArchive(ttlDays: number): number {
  if (ttlDays <= 0) return 0; // 0 = keep forever

  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  let deleted = 0;

  try {
    if (!fs.existsSync(ARCHIVE_DIR)) return 0;

    const projectDirs = fs.readdirSync(ARCHIVE_DIR, { withFileTypes: true });
    for (const entry of projectDirs) {
      if (!entry.isDirectory()) continue;
      const projectPath = path.join(ARCHIVE_DIR, entry.name);
      const files = fs.readdirSync(projectPath);

      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const filePath = path.join(projectPath, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(filePath);
            deleted++;
          }
        } catch { /* skip */ }
      }

      // Remove empty project dirs
      try {
        const remaining = fs.readdirSync(projectPath);
        if (remaining.length === 0) fs.rmdirSync(projectPath);
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  return deleted;
}

export interface ArchiverStats {
  enabled: boolean;
  ttlDays: number;
  totalFiles: number;
  totalSizeBytes: number;
  oldestFile: string | null;
  newestFile: string | null;
  projectCount: number;
}

/** Get archiver statistics. */
export function getArchiverStats(): ArchiverStats {
  const enabled = getSetting("session_archiver_enabled") === "true";
  const ttlDays = parseInt(getSetting("session_archiver_ttl") || "90", 10);

  const stats: ArchiverStats = {
    enabled,
    ttlDays,
    totalFiles: 0,
    totalSizeBytes: 0,
    oldestFile: null,
    newestFile: null,
    projectCount: 0,
  };

  try {
    if (!fs.existsSync(ARCHIVE_DIR)) return stats;

    const projectDirs = fs.readdirSync(ARCHIVE_DIR, { withFileTypes: true });
    let oldestMs = Infinity;
    let newestMs = 0;

    for (const entry of projectDirs) {
      if (!entry.isDirectory()) continue;
      const projectPath = path.join(ARCHIVE_DIR, entry.name);
      const files = fs.readdirSync(projectPath).filter((f) => f.endsWith(".jsonl"));
      if (files.length === 0) continue;

      stats.projectCount++;

      for (const file of files) {
        try {
          const filePath = path.join(projectPath, file);
          const fileStat = fs.statSync(filePath);
          stats.totalFiles++;
          stats.totalSizeBytes += fileStat.size;
          if (fileStat.mtimeMs < oldestMs) {
            oldestMs = fileStat.mtimeMs;
            stats.oldestFile = new Date(fileStat.mtimeMs).toISOString();
          }
          if (fileStat.mtimeMs > newestMs) {
            newestMs = fileStat.mtimeMs;
            stats.newestFile = new Date(fileStat.mtimeMs).toISOString();
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }

  return stats;
}

/** Check if archiver is enabled. */
export function isArchiverEnabled(): boolean {
  return getSetting("session_archiver_enabled") === "true";
}

/** Get TTL in days. 0 = forever. */
export function getArchiverTtl(): number {
  const val = getSetting("session_archiver_ttl");
  if (!val || val === "0" || val === "forever") return 0;
  return parseInt(val, 10) || 90;
}
