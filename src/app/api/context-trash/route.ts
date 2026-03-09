import { NextRequest } from "next/server";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export const dynamic = "force-dynamic";

const CONFIG_PATH = path.join(os.homedir(), ".config", "compress-on-input", "config.json");
const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");

interface Config {
  imageOcr: boolean;
  jsonCollapse: boolean;
  textCompressionThreshold: number;
  ocrEngine: string;
  verbose: boolean;
  dryRun: boolean;
  geminiApiKey?: string;
}

const DEFAULTS: Config = {
  imageOcr: true,
  jsonCollapse: true,
  textCompressionThreshold: 100_000,
  ocrEngine: "auto",
  verbose: false,
  dryRun: false,
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

function isHookInstalled(): boolean {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return false;
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    const groups = settings?.hooks?.PostToolUse;
    if (!Array.isArray(groups)) return false;
    return groups.some((g: { hooks?: { command?: string }[] }) =>
      g.hooks?.some((h) => h.command?.includes("compress-on-input"))
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
  if (!hooks.PostToolUse) hooks.PostToolUse = [];

  const groups = hooks.PostToolUse as { hooks?: { command?: string }[] }[];
  if (groups.some((g) => g.hooks?.some((h) => h.command?.includes("compress-on-input")))) {
    return;
  }

  groups.push({
    matcher: ".*",
    hooks: [{ type: "command", command: "compress-on-input --hook --verbose", timeout: 15 }],
  } as never);

  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

function uninstallHook(): void {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return;
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    if (!settings?.hooks?.PostToolUse) return;

    settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(
      (g: { hooks?: { command?: string }[] }) =>
        !g.hooks?.some((h) => h.command?.includes("compress-on-input"))
    );

    if (settings.hooks.PostToolUse.length === 0) delete settings.hooks.PostToolUse;
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  } catch { /* ignore */ }
}

function isInstalled(): boolean {
  try {
    const { execSync } = require("child_process");
    execSync(process.platform === "win32" ? "where compress-on-input" : "which compress-on-input", { stdio: "pipe" });
    return true;
  } catch { return false; }
}

// GET — return current config + hook status
export async function GET() {
  const config = loadConfig();
  const hookInstalled = isHookInstalled();
  const binaryInstalled = isInstalled();

  return Response.json({
    installed: binaryInstalled,
    hookEnabled: hookInstalled,
    config: {
      imageOcr: config.imageOcr,
      jsonCollapse: config.jsonCollapse,
      textCompressionThreshold: config.textCompressionThreshold,
      ocrEngine: config.ocrEngine,
      verbose: config.verbose,
    },
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
  if (typeof body.imageOcr === "boolean") configUpdates.imageOcr = body.imageOcr;
  if (typeof body.jsonCollapse === "boolean") configUpdates.jsonCollapse = body.jsonCollapse;
  if (typeof body.textCompressionThreshold === "number") configUpdates.textCompressionThreshold = body.textCompressionThreshold;
  if (typeof body.ocrEngine === "string") configUpdates.ocrEngine = body.ocrEngine;
  if (typeof body.verbose === "boolean") configUpdates.verbose = body.verbose;

  if (Object.keys(configUpdates).length > 0) {
    saveConfig(configUpdates);
  }

  // Return fresh state
  const config = loadConfig();
  return Response.json({
    ok: true,
    installed: isInstalled(),
    hookEnabled: isHookInstalled(),
    config: {
      imageOcr: config.imageOcr,
      jsonCollapse: config.jsonCollapse,
      textCompressionThreshold: config.textCompressionThreshold,
      ocrEngine: config.ocrEngine,
      verbose: config.verbose,
    },
  });
}
