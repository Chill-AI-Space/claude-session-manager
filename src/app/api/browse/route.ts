import { NextRequest } from "next/server";
import os from "os";
import path from "path";
import { readdir } from "fs/promises";
import { getSetting } from "@/lib/db";

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

  const homedir = os.homedir();
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
          const children = await readdir(fullPath, { withFileTypes: true });
          hasChildren = children.some(
            (c) => c.isDirectory() && (showHidden || !c.name.startsWith("."))
          );
        } catch {
          // Permission denied or other error
        }
        return { name: item.name, path: fullPath, hasChildren };
      })
    );

    const startPath = resolveStartPath();
    const parentPath = resolved === homedir || resolved === startPath
      ? null
      : path.dirname(resolved);

    return Response.json({ entries, currentPath: resolved, parentPath });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: msg }, { status: 500 });
  }
}
