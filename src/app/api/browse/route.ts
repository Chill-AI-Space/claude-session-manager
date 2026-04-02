import { NextRequest } from "next/server";
import os from "os";
import path from "path";
import { readdir, mkdir, opendir } from "fs/promises";
import { getSetting } from "@/lib/db";

async function searchDirs(
  root: string,
  query: string,
  homedir: string,
  maxDepth = 4,
  results: { name: string; path: string }[] = [],
  depth = 0
): Promise<{ name: string; path: string }[]> {
  if (depth > maxDepth || results.length >= 50) return results;
  try {
    const items = await readdir(root, { withFileTypes: true });
    for (const item of items) {
      if (!item.isDirectory() || item.name.startsWith(".") || item.name === "node_modules") continue;
      const fullPath = path.join(root, item.name);
      if (!fullPath.startsWith(homedir)) continue;
      if (item.name.toLowerCase().includes(query.toLowerCase())) {
        results.push({ name: item.name, path: fullPath });
        if (results.length >= 50) return results;
      }
      await searchDirs(fullPath, query, homedir, maxDepth, results, depth + 1);
    }
  } catch { /* permission denied etc */ }
  return results;
}

export const dynamic = "force-dynamic";

function resolveStartPath(): string {
  const setting = getSetting("browse_start_path");
  if (!setting) return os.homedir();
  // Expand ~ to homedir
  const expanded = setting.startsWith("~")
    ? path.join(os.homedir(), setting.slice(1))
    : setting;
  const resolved = path.resolve(expanded);
  // Must be within homedir
  if (!resolved.startsWith(os.homedir())) return os.homedir();
  return resolved;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const requestedPath = searchParams.get("path") || resolveStartPath();
  const showHidden = searchParams.get("showHidden") === "true";
  const query = searchParams.get("q");

  const homedir = os.homedir();

  // Search mode: recursive substring match on folder name
  if (query && query.trim()) {
    const startPath = resolveStartPath();
    const results = await searchDirs(startPath, query.trim(), homedir);
    return Response.json({ entries: results, search: true, homeDir: homedir });
  }

  const resolved = path.resolve(requestedPath);

  // Security: must be within homedir
  if (!resolved.startsWith(homedir)) {
    return Response.json({ error: "Path must be within home directory" }, { status: 403 });
  }

  try {
    const items = await readdir(resolved, { withFileTypes: true });
    const dirs = items
      .filter((item) => item.isDirectory())
      .filter((item) => showHidden || !item.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name));

    const entries = await Promise.all(
      dirs.map(async (item) => {
        const fullPath = path.join(resolved, item.name);
        let hasChildren = false;
        try {
          // Use opendir + async iterator to stop as soon as we find one subdir
          // (avoids reading all entries just to check if any directory exists)
          const dir = await opendir(fullPath);
          for await (const child of dir) {
            if (child.isDirectory() && (showHidden || !child.name.startsWith("."))) {
              hasChildren = true;
              await dir.close();
              break;
            }
          }
        } catch {
          // Permission denied or other error
        }
        return { name: item.name, path: fullPath, hasChildren };
      })
    );

    const parentPath = resolved === homedir
      ? null
      : path.dirname(resolved);

    return Response.json({ entries, currentPath: resolved, parentPath, homeDir: homedir });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: msg }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const { parentPath, name } = await request.json();
  if (!parentPath || !name) {
    return Response.json({ error: "parentPath and name are required" }, { status: 400 });
  }

  const homedir = os.homedir();
  const resolved = path.resolve(parentPath);
  if (!resolved.startsWith(homedir)) {
    return Response.json({ error: "Path must be within home directory" }, { status: 403 });
  }

  // Sanitize name: no path separators, no hidden folders
  const safeName = name.trim().replace(/[/\\]/g, "");
  if (!safeName || safeName.startsWith(".")) {
    return Response.json({ error: "Invalid folder name" }, { status: 400 });
  }

  const newPath = path.join(resolved, safeName);
  try {
    await mkdir(newPath, { recursive: false });
    return Response.json({ ok: true, path: newPath, name: safeName });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: msg }, { status: 500 });
  }
}
