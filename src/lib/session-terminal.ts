import { getSetting } from "@/lib/db";
import { getClaudePath } from "@/lib/claude-bin";
import { getForgePath } from "@/lib/forge-bin";
import { getCodexPath } from "@/lib/codex-bin";
import { getOpencodePath } from "@/lib/opencode-bin";
import { applyOpencodeProfile } from "@/lib/opencode-profiles";
import { buildPromptLoader, shellQuote, writeTempPromptFile } from "@/lib/prompt-file";
import { SessionRow } from "@/lib/types";

export { shellQuote } from "@/lib/prompt-file";

/**
 * Interactive `opencode --prompt <prompt>` in a fresh terminal.
 *
 * This must be the root command with --prompt, NOT `opencode run <message>`.
 * `run` is a one-shot/scripting subcommand — it answers once and the process
 * exits back to the shell, with no way to type a follow-up in the same
 * window (unlike Claude/Codex, which drop into an interactive REPL after the
 * first message). The root command's default action is the interactive TUI;
 * --prompt sends the initial message into it and leaves it running for
 * follow-ups, matching how Claude/Codex sessions behave here.
 *
 * OpenCode has no single "model" flag equivalent to Claude's — this setup
 * switches between named profiles (Quality, Value, Free, ...), each of which
 * sets models for several OpenCode roles at once (see src/lib/opencode-profiles.ts).
 * `profileId` is applied to ~/.config/opencode/opencode.json right before launch,
 * the same way the `oc <profile>` shell function does, so the TUI picks it up.
 *
 * The prompt is loaded from a temp file — long/multi-line prompts must never be
 * embedded in the command string, because iTerm2's AppleScript `write text`
 * truncates around 1024 chars (see prompt-file.ts).
 */
export function buildOpencodeStartShellCommand(projectPath: string, message: string, profileId?: string): string {
  const bin = getOpencodePath();
  if (profileId) applyOpencodeProfile(profileId);
  const promptPath = writeTempPromptFile(message, "csm-opencode-prompt");
  return `cd ${shellQuote(projectPath)} && ${buildPromptLoader(promptPath)} && ${shellQuote(bin)} --prompt "$PROMPT"`;
}

/** Interactive `claude "<prompt>"` in a fresh terminal — a brand new session, not a resume. */
export function buildStartShellCommand(projectPath: string, message: string, modelOverride?: string, appendSystemPrompt?: string): string {
  const bin = getClaudePath();
  const skipPermissions = getSetting("dangerously_skip_permissions") === "true";
  const skipFlag = skipPermissions ? " --dangerously-skip-permissions" : "";
  const model = modelOverride || getSetting("claude_model");
  const modelFlag = model ? ` --model ${shellQuote(model)}` : "";

  const promptPath = writeTempPromptFile(message, "csm-claude-prompt");
  const parts = [`cd ${shellQuote(projectPath)}`, buildPromptLoader(promptPath)];
  let systemPromptFlag = "";
  if (appendSystemPrompt) {
    const systemPath = writeTempPromptFile(appendSystemPrompt, "csm-claude-system");
    parts.push(buildPromptLoader(systemPath, "SYS_PROMPT"));
    systemPromptFlag = ` --append-system-prompt "$SYS_PROMPT"`;
  }
  parts.push(`${shellQuote(bin)}${skipFlag}${modelFlag}${systemPromptFlag} "$PROMPT"`);
  return parts.join(" && ");
}

export function buildResumeShellCommand(session: SessionRow, message?: string): string {
  const cwd = session.project_path;
  const skipPermissions = getSetting("dangerously_skip_permissions") === "true";
  const skipFlag = skipPermissions ? " --dangerously-skip-permissions" : "";
  const agentType = (session as SessionRow & { agent_type?: string }).agent_type ?? "claude";
  const isForge = agentType === "forge";
  const isCodex = agentType === "codex";
  const isOpencode = agentType === "opencode";

  // Forge resumes by conversation-id only and ignores any message, so don't
  // create a prompt file for it.
  const wantsPrompt = Boolean(message) && !isForge;
  const promptFlag = wantsPrompt ? ` --prompt "$PROMPT"` : "";
  const promptLoader = wantsPrompt ? ` && ${buildPromptLoader(writeTempPromptFile(message!, "csm-reply-prompt"))}` : "";

  if (isOpencode) {
    const bin = getOpencodePath();
    // Root command's --session, not `run -s` — same reasoning as the start
    // command above: this needs to reopen the interactive TUI attached to
    // that session, not run one more one-shot exchange and exit. --prompt
    // is accepted alongside --session (both root flags), so a reply can
    // resume the session AND send the new message in one shot.
    return `cd ${shellQuote(cwd)}${promptLoader} && ${shellQuote(bin)} --session ${shellQuote(session.session_id)}${promptFlag}`;
  }

  if (isCodex) {
    const bin = getCodexPath();
    const codexSkipFlag = skipPermissions ? " --dangerously-bypass-approvals-and-sandbox" : "";
    return `cd ${shellQuote(cwd)}${promptLoader} && ${shellQuote(bin)}${codexSkipFlag} resume ${shellQuote(session.session_id)}${message ? ` "$PROMPT"` : ""}`;
  }

  if (isForge) {
    const bin = getForgePath();
    const model = (session as SessionRow & { model?: string | null }).model || null;
    const forgeModelCmd = model ? `${shellQuote(bin)} config set model ${shellQuote(model)} && ` : "";
    return `cd ${shellQuote(cwd)} && ${forgeModelCmd}${shellQuote(bin)} --conversation-id ${shellQuote(session.session_id)}`;
  }

  const bin = getClaudePath();
  const model = getSetting("claude_model");
  const modelFlag = model ? ` --model ${shellQuote(model)}` : "";
  // Interactive resume — NOT headless (-p). The message, if given, is the initial
  // prompt typed into the normal interactive TUI, so the session stays a single
  // live process the user can keep driving from the terminal.
  const claudePromptFlag = message ? ` "$PROMPT"` : "";
  return `cd ${shellQuote(cwd)}${promptLoader} && ${shellQuote(bin)} --resume ${shellQuote(session.session_id)}${skipFlag}${modelFlag}${claudePromptFlag}`;
}
