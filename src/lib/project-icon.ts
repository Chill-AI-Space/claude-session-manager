/**
 * Project icon system — generates/fetches per-project favicons.
 *
 * - GitHub repos: fetches the owner's avatar from GitHub
 * - Non-GitHub repos: generates an SVG icon via AI (GPT-4o-mini)
 * - Fallback: letter-based SVG icon (no API key needed)
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getSetting } from "./db";

const ICONS_DIR = path.join(process.cwd(), "data", "project-icons");

function ensureIconsDir() {
  if (!fs.existsSync(ICONS_DIR)) {
    fs.mkdirSync(ICONS_DIR, { recursive: true });
  }
}

/** Hash a project path to a stable filename */
function pathHash(projectPath: string): string {
  return crypto.createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
}

/** Get the cached icon path for a project (any extension) */
function getCachedIconPath(projectPath: string): string | null {
  ensureIconsDir();
  const hash = pathHash(projectPath);
  for (const ext of [".png", ".svg", ".jpg"]) {
    const p = path.join(ICONS_DIR, hash + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Parse GitHub owner from a git remote URL */
function parseGitHubOwner(remoteUrl: string): string | null {
  // https://github.com/owner/repo.git or git@github.com:owner/repo.git
  const httpsMatch = remoteUrl.match(/github\.com\/([^/]+)\//);
  if (httpsMatch) return httpsMatch[1];
  const sshMatch = remoteUrl.match(/github\.com:([^/]+)\//);
  if (sshMatch) return sshMatch[1];
  return null;
}

/** Try to get GitHub remote URL from a project path */
function getGitHubRemote(projectPath: string): { owner: string; repo: string } | null {
  try {
    if (!fs.existsSync(projectPath)) return null;
    const remote = execSync(`git -C "${projectPath}" remote get-url origin 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    const owner = parseGitHubOwner(remote);
    if (!owner) return null;
    const repoMatch = remote.match(/\/([^/]+?)(?:\.git)?$/);
    const repo = repoMatch ? repoMatch[1] : "";
    return { owner, repo };
  } catch {
    return null;
  }
}

/** Fetch GitHub owner avatar and save as PNG */
async function fetchGitHubAvatar(owner: string, projectPath: string): Promise<string> {
  const url = `https://github.com/${owner}.png?size=64`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GitHub avatar fetch failed: ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  ensureIconsDir();
  const iconPath = path.join(ICONS_DIR, pathHash(projectPath) + ".png");
  fs.writeFileSync(iconPath, buffer);
  return iconPath;
}

/** Generate a letter-based SVG favicon (no API needed) */
function generateLetterIcon(projectPath: string): string {
  const name = path.basename(projectPath);
  // Pick 1-2 letters from the project name
  const words = name.replace(/[-_]/g, " ").split(/\s+/).filter(Boolean);
  const letters = words.length >= 2
    ? (words[0][0] + words[1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();

  // Deterministic color from path hash
  const hash = crypto.createHash("md5").update(projectPath).digest("hex");
  const hue = parseInt(hash.slice(0, 3), 16) % 360;
  const sat = 55 + (parseInt(hash.slice(3, 5), 16) % 25); // 55-80%
  const light = 45 + (parseInt(hash.slice(5, 7), 16) % 15); // 45-60%

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="hsl(${hue}, ${sat}%, ${light}%)"/>
  <text x="32" y="32" text-anchor="middle" dominant-baseline="central"
    font-family="system-ui, -apple-system, sans-serif" font-weight="700"
    font-size="${letters.length > 1 ? 24 : 32}" fill="white">${letters}</text>
</svg>`;

  ensureIconsDir();
  const iconPath = path.join(ICONS_DIR, pathHash(projectPath) + ".svg");
  fs.writeFileSync(iconPath, svg, "utf-8");
  return iconPath;
}

/** Generate an AI icon via GPT-4o-mini (returns SVG) */
async function generateAiIcon(projectPath: string, context?: string): Promise<string> {
  const apiKey = getSetting("openai_api_key") || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Fallback to letter icon if no API key
    return generateLetterIcon(projectPath);
  }

  const projectName = path.basename(projectPath);
  const prompt = context
    ? `Generate a simple, minimalist SVG favicon (64x64 viewBox) for a software project called "${projectName}". Context: "${context.slice(0, 200)}". Requirements: single clean shape or icon, bold colors, no text, suitable as a browser tab favicon. Return ONLY the SVG code, nothing else.`
    : `Generate a simple, minimalist SVG favicon (64x64 viewBox) for a software project called "${projectName}". Requirements: single clean shape or icon, bold colors, no text, suitable as a browser tab favicon. Return ONLY the SVG code, nothing else.`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are an icon designer. Return only valid SVG code. No markdown, no explanation." },
        { role: "user", content: prompt },
      ],
      max_tokens: 1000,
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    console.error(`OpenAI icon generation failed: ${res.status}`);
    return generateLetterIcon(projectPath);
  }

  const data = await res.json();
  let svg = data.choices?.[0]?.message?.content ?? "";

  // Strip markdown code fences if present
  svg = svg.replace(/^```(?:svg|xml)?\n?/i, "").replace(/\n?```$/i, "").trim();

  // Validate it looks like SVG
  if (!svg.includes("<svg")) {
    return generateLetterIcon(projectPath);
  }

  ensureIconsDir();
  const iconPath = path.join(ICONS_DIR, pathHash(projectPath) + ".svg");
  fs.writeFileSync(iconPath, svg, "utf-8");
  return iconPath;
}

/**
 * Get or generate a project icon.
 * Returns { path, contentType } for the icon file.
 */
export async function getProjectIcon(
  projectPath: string,
  options?: { regenerate?: boolean; context?: string }
): Promise<{ filePath: string; contentType: string }> {
  // Check cache first (unless regenerating)
  if (!options?.regenerate) {
    const cached = getCachedIconPath(projectPath);
    if (cached) {
      return {
        filePath: cached,
        contentType: cached.endsWith(".svg") ? "image/svg+xml" : "image/png",
      };
    }
  }

  // Try GitHub avatar
  const github = getGitHubRemote(projectPath);
  if (github) {
    try {
      const iconPath = await fetchGitHubAvatar(github.owner, projectPath);
      return { filePath: iconPath, contentType: "image/png" };
    } catch (e) {
      console.error(`Failed to fetch GitHub avatar for ${github.owner}:`, e);
    }
  }

  // Try AI generation, fallback to letter icon
  try {
    const iconPath = await generateAiIcon(projectPath, options?.context);
    return {
      filePath: iconPath,
      contentType: iconPath.endsWith(".svg") ? "image/svg+xml" : "image/png",
    };
  } catch (e) {
    console.error("AI icon generation failed:", e);
    const iconPath = generateLetterIcon(projectPath);
    return { filePath: iconPath, contentType: "image/svg+xml" };
  }
}

/** Delete cached icon for a project */
export function deleteProjectIcon(projectPath: string): boolean {
  const cached = getCachedIconPath(projectPath);
  if (cached) {
    fs.unlinkSync(cached);
    return true;
  }
  return false;
}
