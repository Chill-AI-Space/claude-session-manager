/**
 * Clone URL for a repo we only know by name.
 *
 * Lives outside `project-path.ts` on purpose: that module stays free of DB
 * imports so it is unit-testable (same split as `session-worktree.ts`).
 */
import { getDb } from "./db";
import { originUrl } from "./project-path";

/**
 * Ask past sessions where this repo used to live and read that checkout's
 * `origin` — the only way to clone when the requested path itself is gone.
 */
export async function lookupOriginUrl(repoName: string): Promise<string | null> {
  let rows: { project_path: string | null }[] = [];
  try {
    rows = getDb()
      .prepare(
        `SELECT project_path FROM sessions
          WHERE project_path IS NOT NULL AND LOWER(project_path) LIKE '%/' || LOWER(?)
          ORDER BY file_mtime DESC LIMIT 5`,
      )
      .all(repoName) as { project_path: string | null }[];
  } catch {
    return null;
  }
  for (const row of rows) {
    if (!row.project_path) continue;
    const url = await originUrl(row.project_path);
    if (url) return url;
  }
  return null;
}
