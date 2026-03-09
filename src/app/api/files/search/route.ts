import { NextRequest, NextResponse } from "next/server";
import { readdirSync, statSync } from "fs";
import path from "path";

export const dynamic = "force-dynamic";

const IGNORED = new Set([
  "node_modules", ".git", ".next", "__pycache__", ".DS_Store",
  "dist", "build", ".cache", "coverage", ".turbo", "venv", ".venv",
]);

interface SearchResult {
  path: string;
  name: string;
  ext: string;
  dir: string;
}

function searchDir(dir: string, query: string, results: SearchResult[], maxResults = 200) {
  if (results.length >= maxResults) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (IGNORED.has(name) || name.startsWith(".")) continue;
    const fullPath = path.join(dir, name);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      searchDir(fullPath, query, results, maxResults);
    } else if (name.toLowerCase().includes(query.toLowerCase())) {
      results.push({
        path: fullPath,
        name,
        ext: path.extname(name).toLowerCase().slice(1),
        dir: path.dirname(fullPath),
      });
    }
    if (results.length >= maxResults) return;
  }
}

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q") ?? "";
  const rootsParam = request.nextUrl.searchParams.get("roots");

  if (!q.trim()) return NextResponse.json({ results: [] });
  if (!rootsParam) return NextResponse.json({ error: "roots required" }, { status: 400 });

  let roots: string[];
  try {
    roots = JSON.parse(rootsParam);
  } catch {
    return NextResponse.json({ error: "roots must be JSON array" }, { status: 400 });
  }

  const results: SearchResult[] = [];
  for (const root of roots) {
    searchDir(root, q, results);
  }

  return NextResponse.json({ results });
}
