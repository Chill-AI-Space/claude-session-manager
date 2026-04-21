import fs from "fs";
import { describe, expect, it } from "vitest";

import {
  buildCodexOpenArgs,
  buildCodexResumeArgs,
  buildCodexResumeShellCommand,
  buildCodexStartArgs,
  buildCodexStartShellCommand,
} from "../codex-command";

function extractPromptPath(cmd: string): string {
  const match = cmd.match(/PROMPT_FILE='([^']+)'/);
  if (!match) throw new Error(`PROMPT_FILE not found in command: ${cmd}`);
  return match[1];
}

describe("codex command builder", () => {
  it("writes multi-line start prompts with URLs to a temp file instead of embedding them in shell", () => {
    const message = `можешь организовать разбор кандидатов (ну и переписку) https://hh.ru/vacancy/132032392

там этапы: уточнить опыт в b2b спросить средний чек

если чел соглашается то отправлять https://docs.google.com/document/d/1GaSQ6wAEegGGmSKv_v4hOAF5K0b9eWAbAY-YG2KwOHM/edit?tab=t.0`;

    const cmd = buildCodexStartShellCommand({
      projectPath: "/Users/vova/Documents/GitHub/hiring-agent",
      bin: "/Users/vova/.nvm/versions/node/v24.13.0/bin/codex",
      message,
      skipPermissions: true,
      model: "gpt-5.4",
    });

    expect(cmd).not.toContain(message);
    expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(cmd).toContain("-c 'model=gpt-5.4'");
    expect(cmd).toContain('exec \'/Users/vova/.nvm/versions/node/v24.13.0/bin/codex\'');

    const promptPath = extractPromptPath(cmd);
    expect(fs.readFileSync(promptPath, "utf8")).toBe(message);
    fs.unlinkSync(promptPath);
  });

  it("builds resume command with session id and preserves quoted content in temp file", () => {
    const message = `если ок, отправь: "давайте я вам отправлю наш план действий"

https://example.com/path?foo=1&bar=2`;

    const cmd = buildCodexResumeShellCommand({
      projectPath: "/tmp/project with spaces",
      bin: "/opt/homebrew/bin/codex",
      sessionId: "session-123",
      message,
      skipPermissions: false,
    });

    expect(cmd).toContain("resume 'session-123' \"$PROMPT\"");
    expect(cmd).toContain("cd '/tmp/project with spaces'");
    expect(cmd).not.toContain(message);

    const promptPath = extractPromptPath(cmd);
    expect(fs.readFileSync(promptPath, "utf8")).toBe(message);
    fs.unlinkSync(promptPath);
  });

  it("builds Windows-safe start args without shell quoting", () => {
    const args = buildCodexStartArgs({
      message: "line 1\nline 2 \"quoted\"",
      skipPermissions: true,
      model: "gpt-5.4",
    });

    expect(args).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      "model=gpt-5.4",
      "line 1\nline 2 \"quoted\"",
    ]);
  });

  it("builds Windows-safe resume/open args", () => {
    expect(buildCodexResumeArgs({
      sessionId: "session-123",
      message: "continue\nplease",
      skipPermissions: true,
    })).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      "resume",
      "session-123",
      "continue\nplease",
    ]);

    expect(buildCodexOpenArgs({
      sessionId: "session-123",
      skipPermissions: false,
    })).toEqual([
      "resume",
      "session-123",
    ]);
  });
});
