import { NextRequest } from "next/server";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export const dynamic = "force-dynamic";

const CONFIG_PATH = path.join(os.homedir(), ".config", "compact-by-parts", "config.json");
const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const LOGS_DIR = path.join(os.homedir(), ".config", "compact-by-parts", "logs");
const BIN_PATH = path.join(os.homedir(), "Documents", "GitHub", "compact-by-parts", "bin", "compact-by-parts.js");

interface Config {
  contextThresholdPercent: number;
  maxContextTokens: number;
  minChunkSizeChars: number;
  chunkSelectionPercent: number;
  skipLastNMessages: number;
  relevanceWeights: number[];
  targetCompressionRatio: number;
  geminiModel: string;
  geminiApiKey: string;
  maxConcurrentCompressions: number;
  cooldownMinutes: number;
  backupEnabled: boolean;
}

const DEFAULTS: Config = {
  contextThresholdPercent: 50,
  maxContextTokens: 200000,
  minChunkSizeChars: 1000,
  chunkSelectionPercent: 85,
  skipLastNMessages: 5,
  relevanceWeights: [1.0, 0.5, 0.25],
  targetCompressionRatio: 0.2,
  geminiModel: "gemini-2.0-flash",
  geminiApiKey: "",
  maxConcurrentCompressions: 20,
  cooldownMinutes: 2,
  backupEnabled: true,
};

function loadConfig(): Config {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      return { ...DEFAULTS, ...raw };
    }
  } catch { /* use defaults */ }
  return { ...DEFAULTS };
}

function saveConfig(config: Partial<Config>): Config {
  const current = loadConfig();
  const merged = { ...current, ...config };
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  return merged;
}

function isInstalled(): boolean {
  try {
    return fs.existsSync(BIN_PATH);
  } catch { return false; }
}

function isHookEnabled(): boolean {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return false;
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    const groups = settings?.hooks?.UserPromptSubmit;
    if (!Array.isArray(groups)) return false;
    return groups.some((g: { hooks?: { command?: string }[] }) =>
      g.hooks?.some((h) => h.command?.includes("compact-by-parts"))
    );
  } catch { return false; }
}

function installHook(): void {
  let settings: Record<string, unknown> = {};
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    }
  } catch { /* fresh settings */ }

  if (!settings.hooks) settings.hooks = {};
  const hooks = settings.hooks as Record<string, unknown[]>;
  if (!hooks.UserPromptSubmit) hooks.UserPromptSubmit = [];

  const groups = hooks.UserPromptSubmit as { hooks?: { command?: string }[] }[];
  if (groups.some((g) => g.hooks?.some((h) => h.command?.includes("compact-by-parts")))) {
    return;
  }

  groups.push({
    hooks: [{
      type: "command",
      command: `node --experimental-strip-types --experimental-transform-types ${BIN_PATH}`,
      timeout: 120000,
    }],
  } as never);

  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

function uninstallHook(): void {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return;
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    if (!settings?.hooks?.UserPromptSubmit) return;

    settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit.filter(
      (g: { hooks?: { command?: string }[] }) =>
        !g.hooks?.some((h) => h.command?.includes("compact-by-parts"))
    );

    if (settings.hooks.UserPromptSubmit.length === 0) delete settings.hooks.UserPromptSubmit;
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  } catch { /* ignore */ }
}

function getRecentLogs(): unknown[] {
  try {
    const files: string[] = fs.readdirSync(LOGS_DIR)
      .filter((f: string) => f.endsWith(".json"))
      .sort()
      .reverse()
      .slice(0, 10);
    return files.map((f: string) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(LOGS_DIR, f), "utf-8"));
      } catch {
        return { file: f, error: "parse error" };
      }
    });
  } catch {
    return [];
  }
}

// GET — return current config + hook status
export async function GET() {
  const config = loadConfig();
  const hookEnabled = isHookEnabled();
  const installed = isInstalled();
  const recentLogs = getRecentLogs();

  return Response.json({
    installed,
    hookEnabled,
    config: {
      contextThresholdPercent: config.contextThresholdPercent,
      maxContextTokens: config.maxContextTokens,
      minChunkSizeChars: config.minChunkSizeChars,
      chunkSelectionPercent: config.chunkSelectionPercent,
      skipLastNMessages: config.skipLastNMessages,
      relevanceWeights: config.relevanceWeights,
      targetCompressionRatio: config.targetCompressionRatio,
      geminiModel: config.geminiModel,
      geminiApiKey: config.geminiApiKey ? "***" + config.geminiApiKey.slice(-4) : "",
      maxConcurrentCompressions: config.maxConcurrentCompressions,
      cooldownMinutes: config.cooldownMinutes,
      backupEnabled: config.backupEnabled,
    },
    recentLogs,
  });
}

// PUT — update config and/or hook state
export async function PUT(request: NextRequest) {
  const body = await request.json();

  // Toggle hook
  if (typeof body.hookEnabled === "boolean") {
    if (body.hookEnabled) {
      installHook();
    } else {
      uninstallHook();
    }
  }

  // Update config values
  const configUpdates: Partial<Config> = {};
  if (typeof body.contextThresholdPercent === "number") configUpdates.contextThresholdPercent = body.contextThresholdPercent;
  if (typeof body.maxContextTokens === "number") configUpdates.maxContextTokens = body.maxContextTokens;
  if (typeof body.minChunkSizeChars === "number") configUpdates.minChunkSizeChars = body.minChunkSizeChars;
  if (typeof body.chunkSelectionPercent === "number") configUpdates.chunkSelectionPercent = body.chunkSelectionPercent;
  if (typeof body.skipLastNMessages === "number") configUpdates.skipLastNMessages = body.skipLastNMessages;
  if (Array.isArray(body.relevanceWeights)) configUpdates.relevanceWeights = body.relevanceWeights;
  if (typeof body.targetCompressionRatio === "number") configUpdates.targetCompressionRatio = body.targetCompressionRatio;
  if (typeof body.geminiModel === "string") configUpdates.geminiModel = body.geminiModel;
  if (typeof body.geminiApiKey === "string" && !body.geminiApiKey.startsWith("***")) configUpdates.geminiApiKey = body.geminiApiKey;
  if (typeof body.maxConcurrentCompressions === "number") configUpdates.maxConcurrentCompressions = body.maxConcurrentCompressions;
  if (typeof body.cooldownMinutes === "number") configUpdates.cooldownMinutes = body.cooldownMinutes;
  if (typeof body.backupEnabled === "boolean") configUpdates.backupEnabled = body.backupEnabled;

  if (Object.keys(configUpdates).length > 0) {
    saveConfig(configUpdates);
  }

  // Return fresh state
  const config = loadConfig();
  return Response.json({
    ok: true,
    installed: isInstalled(),
    hookEnabled: isHookEnabled(),
    config: {
      contextThresholdPercent: config.contextThresholdPercent,
      maxContextTokens: config.maxContextTokens,
      minChunkSizeChars: config.minChunkSizeChars,
      chunkSelectionPercent: config.chunkSelectionPercent,
      skipLastNMessages: config.skipLastNMessages,
      relevanceWeights: config.relevanceWeights,
      targetCompressionRatio: config.targetCompressionRatio,
      geminiModel: config.geminiModel,
      geminiApiKey: config.geminiApiKey ? "***" + config.geminiApiKey.slice(-4) : "",
      maxConcurrentCompressions: config.maxConcurrentCompressions,
      cooldownMinutes: config.cooldownMinutes,
      backupEnabled: config.backupEnabled,
    },
    recentLogs: getRecentLogs(),
  });
}
