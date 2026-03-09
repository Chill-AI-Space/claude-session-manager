import { NextRequest, NextResponse } from "next/server";
import { readdirSync, statSync } from "fs";
import path from "path";

export const dynamic = "force-dynamic";

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  ext: string;
  size: number;
  mtime: string;
}

const IGNORED = new Set([
  "node_modules", ".git", ".next", "__pycache__", ".DS_Store",
  "dist", "build", ".cache", "coverage", ".turbo", "venv", ".venv",
]);

export async function GET(request: NextRequest) {
  const dir = request.nextUrl.searchParams.get("path");
  if (!dir) return NextResponse.json({ error: "path required" }, { status: 400 });

  try {
    const entries = readdirSync(dir);
    const result: FileEntry[] = [];

    for (const name of entries) {
      if (IGNORED.has(name) || name.startsWith(".")) continue;
      const fullPath = path.join(dir, name);
      try {
        const stat = statSync(fullPath);
        result.push({
          name,
          path: fullPath,
          type: stat.isDirectory() ? "dir" : "file",
          ext: path.extname(name).toLowerCase().slice(1),
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        });
      } catch {
        // skip unreadable
      }
    }

    // dirs first, then files, both alpha
    result.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return NextResponse.json({ entries: result });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
