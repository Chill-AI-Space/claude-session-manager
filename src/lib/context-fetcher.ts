import { readFileSync, statSync } from "fs";
import path from "path";
import { ContextSourceGroupFull } from "./db";
import { expandTilde } from "./utils";

export type SourceType = "github" | "url" | "local";

// Simple in-memory cache
const cache = new Map<string, { content: string; expiry: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 min

function getCached(key: string): string | null {
  const entry = cache.get(key);
  if (!entry || Date.now() > entry.expiry) { cache.delete(key); return null; }
  return entry.content;
}

function setCached(key: string, content: string): void {
  cache.set(key, { content, expiry: Date.now() + CACHE_TTL });
}

async function fetchGitHub(config: Record<string, unknown>): Promise<string> {
  const repo = config.repo as string | undefined;
  if (!repo) throw new Error("GitHub source missing repo URL");

  const cacheKey = `github:${repo}:${config.branch ?? "HEAD"}:${config.path ?? ""}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const match = repo.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/);
  if (!match) throw new Error(`Invalid GitHub repo URL: ${repo}`);
  const [, owner, repoName] = match;
  const filePath = (config.path as string | undefined) ?? "";
  const ref = (config.branch as string | undefined) ?? "HEAD";
  const pat = config.pat as string | undefined;

  const headers: Record<string, string> = {
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "claude-session-manager",
  };
  if (pat) headers["Authorization"] = `Bearer ${pat}`;

  const apiUrl = filePath
    ? `https://api.github.com/repos/${owner}/${repoName}/contents/${filePath}?ref=${ref}`
    : `https://api.github.com/repos/${owner}/${repoName}/readme?ref=${ref}`;

  const res = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${res.statusText}`);

  const data = await res.json();
  let content: string;

  if (Array.isArray(data)) {
    // Directory — fetch text files (max 10)
    const files = (data as Array<{ type?: string; name?: string; path?: string }>)
      .filter((f) => f.type === "file" && /\.(md|txt|ts|js|py|json|yaml|yml|toml|rst)$/i.test(f.name ?? ""))
      .slice(0, 10);
    const fileContents = await Promise.all(
      files.map(async (f) => {
        const fr = await fetch(
          `https://api.github.com/repos/${owner}/${repoName}/contents/${f.path}?ref=${ref}`,
          { headers }
        );
        const fd = await fr.json() as { content?: string };
        if (fd.content) return `### ${f.path}\n${Buffer.from(fd.content, "base64").toString("utf-8")}`;
        return null;
      })
    );
    content = fileContents.filter(Boolean).join("\n\n---\n\n");
  } else {
    const file = data as { content?: string; encoding?: string; message?: string };
    if (file.message) throw new Error(`GitHub: ${file.message}`);
    content = file.content ? Buffer.from(file.content, "base64").toString("utf-8") : "";
  }

  const truncated = content.slice(0, 60_000);
  setCached(cacheKey, truncated);
  return truncated;
}

async function fetchUrl(config: Record<string, unknown>): Promise<string> {
  const url = config.url as string | undefined;
  if (!url) throw new Error("URL source missing url");

  const cacheKey = `url:${url}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const res = await fetch(url, {
    headers: { "User-Agent": "claude-session-manager" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

  const contentType = res.headers.get("content-type") ?? "";
  let text: string;
  if (contentType.includes("text/html")) {
    const html = await res.text();
    text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } else {
    text = await res.text();
  }

  const truncated = text.slice(0, 60_000);
  setCached(cacheKey, truncated);
  return truncated;
}

function fetchLocal(config: Record<string, unknown>): string {
  const localPath = config.localPath as string | undefined;
  if (!localPath) throw new Error("Local source missing localPath");

  const resolved = expandTilde(localPath);
  const cacheKey = `local:${resolved}`;

  try {
    const mtime = statSync(resolved).mtimeMs;
    const entry = cache.get(cacheKey);
    if (entry && entry.expiry > mtime + CACHE_TTL) return entry.content;
  } catch { /* will throw below */ }

  const content = readFileSync(resolved, "utf-8").slice(0, 60_000);
  setCached(cacheKey, content);
  return content;
}

export async function fetchSource(type: SourceType, config: Record<string, unknown>): Promise<string> {
  switch (type) {
    case "github": return fetchGitHub(config);
    case "url": return fetchUrl(config);
    case "local": return fetchLocal(config);
    default: throw new Error(`Unknown source type: ${type}`);
  }
}

function matchesPattern(projectPath: string, pattern: string): boolean {
  if (!pattern.trim()) return false;
  if (pattern === "*") return true;
  const normalized = expandTilde(pattern);
  return projectPath === normalized || projectPath.startsWith(normalized + path.sep);
}

export async function getContextForProject(
  projectPath: string,
  groups: ContextSourceGroupFull[]
): Promise<Array<{ groupName: string; content: string; tokenEstimate: number }>> {
  const results: Array<{ groupName: string; content: string; tokenEstimate: number }> = [];

  for (const group of groups) {
    if (!group.enabled) continue;
    const applies =
      group.patterns.length === 0 ||
      group.patterns.some((p) => matchesPattern(projectPath, p));
    if (!applies) continue;

    const parts: string[] = [];
    for (const source of group.sources) {
      try {
        const content = await fetchSource(source.type as SourceType, source.config);
        if (content.trim()) {
          const label =
            source.label ??
            (source.config.repo as string | undefined) ??
            (source.config.url as string | undefined) ??
            (source.config.localPath as string | undefined) ??
            source.type;
          parts.push(`## ${label}\n\n${content}`);
        }
      } catch (e) {
        console.error(`[context-sources] group="${group.name}" source=${source.type}:`, e);
      }
    }

    if (parts.length > 0) {
      const content = parts.join("\n\n---\n\n");
      results.push({ groupName: group.name, content, tokenEstimate: Math.round(content.length / 4) });
    }
  }

  return results;
}

export function formatContextBlock(groupName: string, content: string): string {
  return `<context_source name="${groupName}">\n${content}\n</context_source>\n\n`;
}
