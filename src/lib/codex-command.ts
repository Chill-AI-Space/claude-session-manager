import fs from "fs";
import os from "os";
import path from "path";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function writeTempPromptFile(prompt: string): string {
  const promptPath = path.join(
    os.tmpdir(),
    `csm-codex-prompt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
  );
  fs.writeFileSync(promptPath, prompt, "utf8");
  return promptPath;
}

function buildPrefix(projectPath: string): string {
  return `cd ${shellQuote(projectPath)} &&`;
}

function buildFlags(bin: string, skipPermissions: boolean, model?: string): string {
  const parts = [shellQuote(bin)];
  if (skipPermissions) parts.push("--dangerously-bypass-approvals-and-sandbox");
  if (model) parts.push("-c", shellQuote(`model=${model}`));
  return parts.join(" ");
}

function buildPromptLoader(promptPath: string): string {
  return `PROMPT_FILE=${shellQuote(promptPath)}; PROMPT="$(cat "$PROMPT_FILE")"; rm -f "$PROMPT_FILE"`;
}

export function buildCodexStartShellCommand(opts: {
  projectPath: string;
  bin: string;
  message: string;
  skipPermissions: boolean;
  model?: string;
}): string {
  const promptPath = writeTempPromptFile(opts.message);
  return [
    buildPrefix(opts.projectPath),
    buildPromptLoader(promptPath),
    "&&",
    `exec ${buildFlags(opts.bin, opts.skipPermissions, opts.model)} "$PROMPT"`,
  ].join(" ");
}

export function buildCodexResumeShellCommand(opts: {
  projectPath: string;
  bin: string;
  sessionId: string;
  message: string;
  skipPermissions: boolean;
}): string {
  const promptPath = writeTempPromptFile(opts.message);
  return [
    buildPrefix(opts.projectPath),
    buildPromptLoader(promptPath),
    "&&",
    `exec ${buildFlags(opts.bin, opts.skipPermissions)} resume ${shellQuote(opts.sessionId)} "$PROMPT"`,
  ].join(" ");
}
