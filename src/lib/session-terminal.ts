import { getSetting } from "@/lib/db";
import { getClaudePath } from "@/lib/claude-bin";
import { getForgePath } from "@/lib/forge-bin";
import { getCodexPath } from "@/lib/codex-bin";
import { getOpencodePath } from "@/lib/opencode-bin";
import { applyOpencodeProfile } from "@/lib/opencode-profiles";
import { SessionRow } from "@/lib/types";

/** Shell-quote a string for embedding as a single argument in a POSIX shell command. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * Interactive `opencode --prompt "<prompt>"` in a fresh terminal.
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
 * switches between named profiles (Quality, Value, Free, ...), each of
 * which sets models for several OpenCode roles at once (see
 * src/lib/opencode-profiles.ts). `profileId` is applied to
 * ~/.config/opencode/opencode.json right before launch, the same way the
 * `oc <profile>` shell function does, so the TUI picks it up.
 */
export function buildOpencodeStartShellCommand(projectPath: string, message: string, profileId?: string): string {
  const bin = getOpencodePath();
  if (profileId) applyOpencodeProfile(profileId);
  return `cd "${projectPath}" && "${bin}" --prompt ${shellQuote(message)}`;
}

/** Interactive `claude "<prompt>"` in a fresh terminal — a brand new session, not a resume. */
export function buildStartShellCommand(projectPath: string, message: string, modelOverride?: string, appendSystemPrompt?: string): string {
  const bin = getClaudePath();
  const skipPermissions = getSetting("dangerously_skip_permissions") === "true";
  const skipFlag = skipPermissions ? " --dangerously-skip-permissions" : "";
  const model = modelOverride || getSetting("claude_model");
  const modelFlag = model ? ` --model "${model}"` : "";
  const systemPromptFlag = appendSystemPrompt ? ` --append-system-prompt ${shellQuote(appendSystemPrompt)}` : "";
  return `cd "${projectPath}" && "${bin}"${skipFlag}${modelFlag}${systemPromptFlag} ${shellQuote(message)}`;
}

export function buildResumeShellCommand(session: SessionRow, message?: string): string {
  const cwd = session.project_path;
  const skipPermissions = getSetting("dangerously_skip_permissions") === "true";
  const skipFlag = skipPermissions ? " --dangerously-skip-permissions" : "";
  const agentType = (session as SessionRow & { agent_type?: string }).agent_type ?? "claude";
  const isForge = agentType === "forge";
  const isCodex = agentType === "codex";
  const isOpencode = agentType === "opencode";

  if (isOpencode) {
    const bin = getOpencodePath();
    // Root command's --session, not `run -s` — same reasoning as the start
    // command above: this needs to reopen the interactive TUI attached to
    // that session, not run one more one-shot exchange and exit. --prompt
    // is accepted alongside --session (both root flags), so a reply can
    // resume the session AND send the new message in one shot.
    const promptFlag = message ? ` --prompt ${shellQuote(message)}` : "";
    return `cd "${cwd}" && "${bin}" --session "${session.session_id}"${promptFlag}`;
  }

  if (isCodex) {
    const bin = getCodexPath();
    const codexSkipFlag = skipPermissions ? " --dangerously-bypass-approvals-and-sandbox" : "";
    return `cd "${cwd}" && "${bin}"${codexSkipFlag} resume "${session.session_id}"`;
  }

  if (isForge) {
    const bin = getForgePath();
    const model = (session as SessionRow & { model?: string | null }).model || null;
    const forgeModelCmd = model ? `"${bin}" config set model "${model}" && ` : "";
    return `cd "${cwd}" && ${forgeModelCmd}"${bin}" --conversation-id "${session.session_id}"`;
  }

  const bin = getClaudePath();
  const model = getSetting("claude_model");
  const modelFlag = model ? ` --model "${model}"` : "";
  // Interactive resume — NOT headless (-p). The message, if given, is the initial
  // prompt typed into the normal interactive TUI, so the session stays a single
  // live process the user can keep driving from the terminal.
  const messageArg = message ? ` ${shellQuote(message)}` : "";
  return `cd "${cwd}" && "${bin}" --resume "${session.session_id}"${skipFlag}${modelFlag}${messageArg}`;
}
