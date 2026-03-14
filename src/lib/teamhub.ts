import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync } from "fs";
import path from "path";
import os from "os";

const execFileAsync = promisify(execFile);
const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";

const CONFIG_PATH = path.join(os.homedir(), ".teamhub", "config.yaml");

export interface TeamHubContext {
  content: string;
  hubName: string;
  tokenEstimate: number;
}

/** True if TeamHub is installed and has at least one hub configured. */
export function isTeamHubAvailable(): boolean {
  return existsSync(CONFIG_PATH);
}

/**
 * Get the hub name for a project path by reading ~/.teamhub/config.yaml.
 * Mirrors teamhub's getHubForProject logic without requiring the CLI.
 */
export function getHubForProject(projectPath: string): string | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    // Simple YAML parse — we only need the projects map (key-value pairs)
    const raw = readFileSync(CONFIG_PATH, "utf-8");

    // Extract projects section
    const projectsMatch = raw.match(/^projects:\s*\n((?:[ \t]+.+\n?)*)/m);
    if (!projectsMatch) return null;

    const lines = projectsMatch[1].split("\n");
    for (const line of lines) {
      const m = line.match(/^\s+"?([^":\s]+)"?\s*:\s*["']?(\S+?)["']?\s*$/);
      if (!m) continue;
      const [, mappedPath, hubName] = m;
      if (projectPath === mappedPath || projectPath.startsWith(mappedPath)) {
        return hubName;
      }
    }

    // Also check if project lives inside a hub path
    const hubsMatch = raw.match(/^hubs:\s*\n((?:[ \t]+.+\n?)*)/m);
    if (hubsMatch) {
      const hubLines = hubsMatch[1].split("\n");
      let currentHub: string | null = null;
      for (const line of hubLines) {
        const hubNameMatch = line.match(/^\s{2}(\S+):\s*$/);
        if (hubNameMatch) { currentHub = hubNameMatch[1]; continue; }
        const pathMatch = line.match(/^\s{4}path:\s*["']?([^"'\s]+)["']?\s*$/);
        if (pathMatch && currentHub && projectPath.startsWith(pathMatch[1])) {
          return currentHub;
        }
      }
    }
  } catch { /* ignore parse errors */ }
  return null;
}

/**
 * Search TeamHub knowledge base for context relevant to a query.
 * Falls back to `teamhub inject` if search returns nothing.
 * Returns null if TeamHub is not available or project has no hub.
 */
export async function getTeamHubContext(
  projectPath: string,
  query: string,
  maxTokens = 8000
): Promise<TeamHubContext | null> {
  const hubName = getHubForProject(projectPath);
  if (!hubName) return null;

  try {
    // Try dynamic search first (most relevant for the query)
    const { stdout: searchOut } = await execFileAsync(
      npxBin,
      ["teamhub", "search", query, "-p", projectPath, "--top", "5", "--raw"],
      { timeout: 10_000, cwd: projectPath }
    );

    if (searchOut.trim()) {
      const tokenEstimate = Math.round(searchOut.length / 4);
      return { content: searchOut.trim(), hubName, tokenEstimate };
    }
  } catch {
    // search failed — try inject as fallback
  }

  try {
    const { stdout: injectOut } = await execFileAsync(
      npxBin,
      ["teamhub", "inject", "-p", projectPath, "--max-tokens", String(maxTokens)],
      { timeout: 10_000, cwd: projectPath }
    );

    if (injectOut.trim()) {
      const tokenEstimate = Math.round(injectOut.length / 4);
      return { content: injectOut.trim(), hubName, tokenEstimate };
    }
  } catch {
    // teamhub not installed or failed
  }

  return null;
}

// ── messageNeedsContext ──────────────────────────────────────────────────────

const SKIP_PATTERNS = /^(continue|proceed|go ahead|keep going|ok|okay|yes|no|y|n|thanks|thank you|done|stop|cancel|retry|got it|sure|right|correct|ack|acknowledged|next|go on|lgtm|looks good|ship it|approved|nope|nah|yep|yeah|fine|good|great|perfect|nice|cool|awesome|agreed|exactly|understood|roger|will do|on it|noted|confirmed|absolutely|definitely|of course|obviously|certainly|please|pls|thx|ty|kk|k)\s*[.!]?$/i;

const CODE_LIKE = /[/.({}[\]<>]|[a-z][A-Z]|[a-z]_[a-z]|[A-Z]{2,}/;

/**
 * Determines whether a user message warrants context injection.
 * Returns false for trivial, continuation, or meta-command messages
 * to avoid pushing long sessions over the context limit.
 */
export function messageNeedsContext(message: string): boolean {
  const trimmed = message.trim();

  // Rule 1: trivially short
  if (trimmed.length < 10) return false;

  // Rule 2: continuation / meta-command patterns
  if (SKIP_PATTERNS.test(trimmed)) return false;

  // Rule 3: short message without question mark or code-like tokens
  if (trimmed.length < 40 && !trimmed.includes("?") && !CODE_LIKE.test(trimmed)) return false;

  return true;
}

/** Format context for prepending to a user message. */
export function formatContextBlock(ctx: TeamHubContext): string {
  return `<teamhub_context hub="${ctx.hubName}">\n${ctx.content}\n</teamhub_context>\n\n`;
}
