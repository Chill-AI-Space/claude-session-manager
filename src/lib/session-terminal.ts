import { getSetting } from "@/lib/db";
import { getClaudePath } from "@/lib/claude-bin";
import { getForgePath } from "@/lib/forge-bin";
import { getCodexPath } from "@/lib/codex-bin";
import { SessionRow } from "@/lib/types";

export function buildResumeShellCommand(session: SessionRow): string {
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
  return `cd "${cwd}" && "${bin}" --resume "${session.session_id}"${skipFlag}${modelFlag}`;
}
