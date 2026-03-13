import { readFileSync, writeFileSync, copyFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const HOME = os.homedir();
const SETTINGS_PATH = join(HOME, ".claude", "settings.json");
const HOOKS_DIR = join(HOME, ".claude", "hooks");
const HOOK_FILENAME = process.platform === "win32" ? "permission-bridge.cmd" : "permission-bridge.sh";
const SCRIPT_SOURCE = join(process.cwd(), "scripts", HOOK_FILENAME);

function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function writeSettings(settings: Record<string, unknown>) {
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

// GET: Check if installed
export async function GET() {
  const settings = readSettings();
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  const permHooks = hooks?.PermissionRequest as Array<{
    hooks?: Array<{ command?: string }>;
  }>;
  const installed = permHooks?.some((h) =>
    h.hooks?.some((hh) => hh.command?.includes("permission-bridge"))
  );
  return NextResponse.json({ installed: !!installed });
}

// POST: Install hook
export async function POST() {
  const log: string[] = [];

  try {
    // Step 1: Copy script to ~/.claude/hooks/
    mkdirSync(HOOKS_DIR, { recursive: true });
    const dest = join(HOOKS_DIR, HOOK_FILENAME);
    copyFileSync(SCRIPT_SOURCE, dest);
    if (process.platform !== "win32") chmodSync(dest, 0o755);
    log.push(`Copied ${HOOK_FILENAME} → ${dest}`);

    // Step 2: Register hook in settings.json
    const settings = readSettings();
    if (!settings.hooks) settings.hooks = {};
    const hooks = settings.hooks as Record<string, unknown[]>;

    const hookEntry = {
      matcher: "*",
      hooks: [
        {
          type: "command",
          command: dest,
          timeout: 120,
        },
      ],
    };

    // Check if already registered
    const existing = hooks.PermissionRequest as Array<{
      hooks?: Array<{ command?: string }>;
    }>;
    const alreadyRegistered = existing?.some((h) =>
      h.hooks?.some((hh) => hh.command?.includes("permission-bridge"))
    );

    if (alreadyRegistered) {
      log.push("Hook already registered in settings.json");
    } else {
      if (!hooks.PermissionRequest) hooks.PermissionRequest = [];
      (hooks.PermissionRequest as unknown[]).push(hookEntry);
      writeSettings(settings);
      log.push("Registered PermissionRequest hook in ~/.claude/settings.json");
    }

    log.push(
      "\nDone! Restart Claude Code sessions for the hook to take effect."
    );
    return NextResponse.json({ ok: true, log: log.join("\n") });
  } catch (e) {
    log.push(`Error: ${e}`);
    return NextResponse.json({ ok: false, log: log.join("\n") });
  }
}

// DELETE: Uninstall hook
export async function DELETE() {
  const log: string[] = [];

  try {
    const settings = readSettings();
    const hooks = settings.hooks as Record<string, unknown[]> | undefined;

    if (hooks?.PermissionRequest) {
      hooks.PermissionRequest = (
        hooks.PermissionRequest as Array<{
          hooks?: Array<{ command?: string }>;
        }>
      ).filter(
        (h) =>
          !h.hooks?.some((hh) => hh.command?.includes("permission-bridge"))
      );
      if ((hooks.PermissionRequest as unknown[]).length === 0) {
        delete hooks.PermissionRequest;
      }
      writeSettings(settings);
      log.push("Removed PermissionRequest hook from settings.json");
    } else {
      log.push("Hook was not registered");
    }

    return NextResponse.json({ ok: true, log: log.join("\n") });
  } catch (e) {
    log.push(`Error: ${e}`);
    return NextResponse.json({ ok: false, log: log.join("\n") });
  }
}
