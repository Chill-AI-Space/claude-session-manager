import { getSetting } from "@/lib/db";
import { getClaudePath } from "@/lib/claude-bin";
import { getForgePath } from "@/lib/forge-bin";
import { getCodexPath } from "@/lib/codex-bin";
import { SessionRow } from "@/lib/types";

/** Shell-quote a string for embedding as a single argument in a POSIX shell command. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
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
