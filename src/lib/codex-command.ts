import { buildPromptLoader, shellQuote, writeTempPromptFile } from "./prompt-file";

function buildPrefix(projectPath: string): string {
  return `cd ${shellQuote(projectPath)} &&`;
}

function buildFlags(bin: string, skipPermissions: boolean, model?: string): string {
  const parts = [shellQuote(bin)];
  if (skipPermissions) parts.push("--dangerously-bypass-approvals-and-sandbox");
  if (model) parts.push("-c", shellQuote(`model=${model}`));
  return parts.join(" ");
}

export function buildCodexStartShellCommand(opts: {
  projectPath: string;
  bin: string;
  message: string;
  skipPermissions: boolean;
  model?: string;
}): string {
  const promptPath = writeTempPromptFile(opts.message, "csm-codex-prompt");
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
  const promptPath = writeTempPromptFile(opts.message, "csm-codex-prompt");
  return [
    buildPrefix(opts.projectPath),
    buildPromptLoader(promptPath),
    "&&",
    `exec ${buildFlags(opts.bin, opts.skipPermissions)} resume ${shellQuote(opts.sessionId)} "$PROMPT"`,
  ].join(" ");
}
