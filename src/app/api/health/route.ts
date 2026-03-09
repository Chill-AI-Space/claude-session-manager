import { execSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import path from "path";
import os from "os";
import { getSetting } from "@/lib/db";

export const dynamic = "force-dynamic";

function checkCommand(cmd: string): boolean {
  try {
    execSync(
      process.platform === "win32" ? `where ${cmd}` : `which ${cmd}`,
      { stdio: "ignore", timeout: 3000 }
    );
    return true;
  } catch {
    return false;
  }
}

export async function GET() {
  const isWindows = process.platform === "win32";
  const isMac = process.platform === "darwin";

  const claudeOk = checkCommand("claude");
  const rgOk = checkCommand("rg");
  const teamhubOk = existsSync(path.join(os.homedir(), ".teamhub", "config.yaml"));
  const geminiOk = !!process.env.GEMINI_API_KEY;

  const sessionsDir = path.join(os.homedir(), ".claude", "projects");
  let sessionsDirOk = false;
  let sessionCount = 0;
  try {
    const entries = readdirSync(sessionsDir);
    sessionsDirOk = true;
    sessionCount = entries.length;
  } catch { /* not readable */ }

  const skipPerms = getSetting("dangerously_skip_permissions") === "true";

  return Response.json({
    platform: process.platform,
    checks: [
      {
        id: "claude_cli",
        label: "Claude CLI",
        ok: claudeOk,
        required: true,
        fix: claudeOk ? null : "Install Claude Code: https://claude.ai/download",
      },
      {
        id: "sessions_dir",
        label: "Sessions directory",
        ok: sessionsDirOk,
        required: true,
        fix: sessionsDirOk
          ? null
          : `${sessionsDir} not found — run Claude Code at least once to create it`,
        detail: sessionsDirOk ? `${sessionCount} project dirs` : null,
      },
      {
        id: "skip_permissions",
        label: "Skip Permissions",
        ok: skipPerms,
        required: false,
        fix: skipPerms
          ? null
          : "Web replies may hang without this. Enable in Settings → Skip Permissions",
        warn: !skipPerms,
      },
      {
        id: "gemini_api_key",
        label: "Gemini API Key",
        ok: geminiOk,
        required: false,
        fix: geminiOk ? null : "Add GEMINI_API_KEY=... to .env.local for AI-powered session search",
      },
      {
        id: "ripgrep",
        label: "ripgrep (rg)",
        ok: rgOk,
        required: false,
        fix: rgOk ? null : isWindows
          ? "Install ripgrep: winget install BurntSushi.ripgrep.MSVC"
          : isMac
            ? "Install ripgrep: brew install ripgrep"
            : "Install ripgrep: apt install ripgrep",
      },
      {
        id: "teamhub",
        label: "TeamHub",
        ok: teamhubOk,
        required: false,
        fix: teamhubOk ? null : "Optional: install TeamHub for shared team context injection",
      },
      {
        id: "platform_terminal",
        label: "Terminal control",
        ok: isMac,
        required: false,
        fix: isMac ? null : "Focus Terminal and Open in Terminal features require macOS",
      },
      {
        id: "platform_process_detection",
        label: "Process detection",
        ok: !isWindows,
        required: false,
        fix: isWindows
          ? "Active session detection requires macOS or Linux (ps/lsof). Sessions will show as inactive on Windows."
          : null,
      },
    ],
  });
}
