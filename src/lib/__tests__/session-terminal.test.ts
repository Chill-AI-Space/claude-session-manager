import fs from "fs";
import { describe, expect, it, vi } from "vitest";

import { buildOpencodeStartShellCommand, buildResumeShellCommand, buildStartShellCommand } from "../session-terminal";

// Settings are mocked so the permission-flag assertions below don't depend on
// whatever happens to be in the developer's (or CI's) live settings store.
const settings: Record<string, string> = {
  dangerously_skip_permissions: "true",
  claude_model: "",
};
vi.mock("../db", () => ({
  getSetting: (k: string) => settings[k] ?? "",
}));

// The OpenCode profile module reads/writes ~/.config/opencode — mock it so
// these tests never touch the developer's live profile config.
const applyOpencodeProfile = vi.fn();
const getCurrentOpencodeProfile = vi.fn(() => "master");
vi.mock("../opencode-profiles", () => ({
  applyOpencodeProfile: (profileId: string) => applyOpencodeProfile(profileId),
  getCurrentOpencodeProfile: () => getCurrentOpencodeProfile(),
}));

function extractPromptFile(cmd: string, varName = "PROMPT"): string {
  const match = cmd.match(new RegExp(`${varName}_FILE='([^']+)'`));
  if (!match) throw new Error(`${varName}_FILE not found in command: ${cmd}`);
  return match[1];
}

const LONG_MESSAGE = `Implement issue #1374: ${"word ".repeat(300)}`.trim();

const opencodeSession = {
  session_id: "ses_abc123",
  jsonl_path: "opencode://ses_abc123",
  project_dir: "-tmp-proj",
  project_path: "/tmp/proj",
  agent_type: "opencode",
} as Parameters<typeof buildResumeShellCommand>[0];

describe("session-terminal prompt handling", () => {
  it("loads the OpenCode start prompt from a temp file (never embeds a long message)", () => {
    const cmd = buildOpencodeStartShellCommand("/tmp/my project", LONG_MESSAGE);

    expect(cmd).not.toContain(LONG_MESSAGE);
    expect(cmd).toContain('--prompt "$PROMPT"');
    expect(cmd.length).toBeLessThan(500);

    const promptPath = extractPromptFile(cmd);
    expect(fs.readFileSync(promptPath, "utf8")).toBe(LONG_MESSAGE);
    fs.unlinkSync(promptPath);
  });

  it("loads both the Claude message and system prompt from temp files", () => {
    const systemPrompt = `system ${"rule ".repeat(300)}`.trim();
    const cmd = buildStartShellCommand("/tmp/my project", LONG_MESSAGE, undefined, systemPrompt);

    expect(cmd).not.toContain(LONG_MESSAGE);
    expect(cmd).not.toContain(systemPrompt);
    expect(cmd).toContain('"$PROMPT"');
    expect(cmd).toContain('--append-system-prompt "$SYS_PROMPT"');
    expect(cmd.length).toBeLessThan(600);

    const promptPath = extractPromptFile(cmd, "PROMPT");
    const systemPath = extractPromptFile(cmd, "SYS_PROMPT");
    expect(fs.readFileSync(promptPath, "utf8")).toBe(LONG_MESSAGE);
    expect(fs.readFileSync(systemPath, "utf8")).toBe(systemPrompt);
    fs.unlinkSync(promptPath);
    fs.unlinkSync(systemPath);
  });
});

describe("OpenCode permission auto-approval (--auto)", () => {
  it("passes --auto on start when skip-permissions is enabled", () => {
    settings.dangerously_skip_permissions = "true";
    const cmd = buildOpencodeStartShellCommand("/tmp/proj", "do the thing");
    expect(cmd).toContain(" --auto --prompt");
    fs.unlinkSync(extractPromptFile(cmd));
  });

  it("omits --auto on start when skip-permissions is disabled", () => {
    settings.dangerously_skip_permissions = "false";
    const cmd = buildOpencodeStartShellCommand("/tmp/proj", "do the thing");
    expect(cmd).not.toContain("--auto");
    fs.unlinkSync(extractPromptFile(cmd));
  });

  it("passes --auto when resuming a session", () => {
    settings.dangerously_skip_permissions = "true";
    expect(buildResumeShellCommand(opencodeSession)).toContain(` --auto --session 'ses_abc123'`);
  });

  it("passes --auto on a resume that carries a reply message", () => {
    settings.dangerously_skip_permissions = "true";
    const cmd = buildResumeShellCommand(opencodeSession, "and now the follow-up");
    expect(cmd).toContain(` --auto --session 'ses_abc123'`);
    expect(cmd).toContain('--prompt "$PROMPT"');
    fs.unlinkSync(extractPromptFile(cmd));
  });

  it("leaves other agents' commands alone", () => {
    settings.dangerously_skip_permissions = "true";
    const claudeCmd = buildStartShellCommand("/tmp/proj", "hi");
    expect(claudeCmd).toContain("--dangerously-skip-permissions");
    expect(claudeCmd).not.toContain("--auto");
    fs.unlinkSync(extractPromptFile(claudeCmd));
  });
});

describe("OpenCode profile selection", () => {
  it("applies the explicit profile id when one is passed", () => {
    applyOpencodeProfile.mockClear();
    const cmd = buildOpencodeStartShellCommand("/tmp/proj", "do the thing", "phd");
    expect(applyOpencodeProfile).toHaveBeenCalledWith("phd");
    fs.unlinkSync(extractPromptFile(cmd));
  });

  it("applies the last selected profile (getCurrentOpencodeProfile) when no id is passed", () => {
    applyOpencodeProfile.mockClear();
    getCurrentOpencodeProfile.mockReturnValue("phd");
    const cmd = buildOpencodeStartShellCommand("/tmp/proj", "do the thing");
    expect(applyOpencodeProfile).toHaveBeenCalledWith("phd");
    fs.unlinkSync(extractPromptFile(cmd));
  });

  it("falls back to master when no id is passed and no profile was ever selected", () => {
    applyOpencodeProfile.mockClear();
    getCurrentOpencodeProfile.mockReturnValue("master");
    const cmd = buildOpencodeStartShellCommand("/tmp/proj", "do the thing");
    expect(applyOpencodeProfile).toHaveBeenCalledWith("master");
    fs.unlinkSync(extractPromptFile(cmd));
  });
});
