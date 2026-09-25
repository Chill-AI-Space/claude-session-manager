import fs from "fs";
import { describe, expect, it } from "vitest";

import { buildOpencodeStartShellCommand, buildStartShellCommand } from "../session-terminal";

function extractPromptFile(cmd: string, varName = "PROMPT"): string {
  const match = cmd.match(new RegExp(`${varName}_FILE='([^']+)'`));
  if (!match) throw new Error(`${varName}_FILE not found in command: ${cmd}`);
  return match[1];
}

const LONG_MESSAGE = `Implement issue #1374: ${"word ".repeat(300)}`.trim();

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
