import { ParsedMessage, ContentBlock } from "./types";
import { readSessionMessages } from "./session-reader";

/**
 * Convert a session's JSONL file into a readable Markdown document.
 * Deterministic: no AI needed, just structural formatting.
 */
export function sessionToMarkdown(
  jsonlPath: string,
  opts?: {
    sessionId?: string;
    projectPath?: string;
    maxToolResultLen?: number;
    /** Only render last N messages (for lazy loading). Header still uses all messages for stats. */
    messageLimit?: number;
    /** Render messages starting from this index (0-based). Used with messageLimit for pagination. */
    messageOffset?: number;
  }
): string {
  const messages = readSessionMessages(jsonlPath);
  if (!messages.length) return "# Empty session\n";

  const maxToolResult = opts?.maxToolResultLen ?? 2000;
  const parts: string[] = [];

  // --- Header ---
  const firstTs = messages[0]?.timestamp;
  const lastTs = messages[messages.length - 1]?.timestamp;
  const firstUser = messages.find((m) => m.type === "user");
  const model = messages.find((m) => m.type === "assistant" && m.model)?.model;

  parts.push("# Session");
  parts.push("");

  const metaLines: string[] = [];
  if (opts?.sessionId) metaLines.push(`- **ID:** \`${opts.sessionId}\``);
  if (opts?.projectPath) metaLines.push(`- **Project:** \`${opts.projectPath}\``);
  if (model) metaLines.push(`- **Model:** ${model}`);
  if (firstTs) metaLines.push(`- **Started:** ${fmtTime(firstTs)}`);
  if (lastTs && lastTs !== firstTs) metaLines.push(`- **Ended:** ${fmtTime(lastTs)}`);
  metaLines.push(`- **Messages:** ${messages.length}`);

  // Total tokens
  let totalIn = 0, totalOut = 0;
  for (const m of messages) {
    if (m.usage) {
      totalIn += (m.usage.input_tokens || 0) + (m.usage.cache_read_input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0);
      totalOut += m.usage.output_tokens || 0;
    }
  }
  if (totalIn || totalOut) {
    metaLines.push(`- **Tokens:** ${fmtNum(totalIn)} in / ${fmtNum(totalOut)} out`);
  }

  if (firstUser?.git_branch) metaLines.push(`- **Branch:** \`${firstUser.git_branch}\``);

  parts.push(metaLines.join("\n"));
  parts.push("");
  parts.push("---");
  parts.push("");

  // --- Messages (with optional pagination) ---
  const totalMessages = messages.length;
  let renderStart = 0;
  let renderEnd = totalMessages;

  if (opts?.messageLimit != null) {
    if (opts.messageOffset != null) {
      // Explicit range: offset + limit
      renderStart = Math.max(0, opts.messageOffset);
      renderEnd = Math.min(totalMessages, renderStart + opts.messageLimit);
    } else {
      // Default: last N messages
      renderStart = Math.max(0, totalMessages - opts.messageLimit);
      renderEnd = totalMessages;
    }
  }

  if (renderStart > 0) {
    parts.push(`*… ${renderStart} earlier messages not shown*`);
    parts.push("");
  }

  let msgIdx = 0;
  for (let i = 0; i < totalMessages; i++) {
    const msg = messages[i];
    if (msg.type === "compact_boundary") {
      if (i >= renderStart && i < renderEnd) {
        parts.push("---");
        parts.push("");
        parts.push("*\u{1F5DC}\uFE0F Context compacted*");
        if (msg.compactMetadata) {
          const cm = msg.compactMetadata;
          if (cm.tokensBefore && cm.tokensAfter) {
            parts.push(`*${fmtNum(cm.tokensBefore)} → ${fmtNum(cm.tokensAfter)} tokens*`);
          }
        }
        parts.push("");
        parts.push("---");
        parts.push("");
      }
      continue;
    }

    msgIdx++;
    // Skip messages outside render range (but keep counting msgIdx for correct numbering)
    if (i < renderStart || i >= renderEnd) continue;

    const role = msg.type === "user" ? "User" : "Claude";
    const ts = msg.timestamp ? `  <sub>${fmtTime(msg.timestamp)}</sub>` : "";

    parts.push(`### ${role} #${msgIdx}${ts}`);
    parts.push("");

    if (typeof msg.content === "string") {
      parts.push(msg.content);
      parts.push("");
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as ContentBlock[]) {
        parts.push(renderBlock(block, maxToolResult));
        parts.push("");
      }
    }
  }

  return parts.join("\n");
}

/** Like sessionToMarkdown but also returns pagination metadata */
export function sessionToMarkdownPaginated(
  jsonlPath: string,
  opts?: Parameters<typeof sessionToMarkdown>[1]
): { markdown: string; totalMessages: number; renderStart: number; renderEnd: number } {
  const messages = readSessionMessages(jsonlPath);
  const total = messages.length;
  const limit = opts?.messageLimit;
  const offset = opts?.messageOffset;

  let renderStart = 0;
  let renderEnd = total;
  if (limit != null) {
    if (offset != null) {
      renderStart = Math.max(0, offset);
      renderEnd = Math.min(total, renderStart + limit);
    } else {
      renderStart = Math.max(0, total - limit);
      renderEnd = total;
    }
  }

  const markdown = sessionToMarkdown(jsonlPath, opts);
  return { markdown, totalMessages: total, renderStart, renderEnd };
}

function renderBlock(block: ContentBlock, maxToolResult: number): string {
  switch (block.type) {
    case "text":
      return block.text || "";

    case "thinking":
      return `<details>\n<summary>💭 Thinking</summary>\n\n${block.thinking || ""}\n\n</details>`;

    case "tool_use": {
      const input = block.input || {};
      const inputStr = formatToolInput(block.name, input);
      return `**🔧 ${block.name}**\n${inputStr}`;
    }

    case "tool_result": {
      const content = block.content;
      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .filter((b): b is ContentBlock & { type: "text" } => b.type === "text")
          .map((b) => (b as { text: string }).text)
          .join("\n");
      }

      // Strip persisted-output wrapper if present
      const persistedMatch = text.match(/<persisted-output>\n([\s\S]*?)\n<\/persisted-output>/);
      if (persistedMatch) text = persistedMatch[1];

      if (text.length > maxToolResult) {
        text = text.slice(0, maxToolResult) + `\n\n*… truncated (${fmtNum(text.length)} chars total)*`;
      }

      if (!text.trim()) return "*empty result*";

      return `<details>\n<summary>📋 Result</summary>\n\n\`\`\`\n${text}\n\`\`\`\n\n</details>`;
    }

    default:
      return "";
  }
}

/** Format tool input nicely depending on tool type */
function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Read":
      return `\`\`\`\n${input.file_path}\`\`\`` +
        (input.offset ? ` (lines ${input.offset}–${Number(input.offset) + Number(input.limit || 100)})` : "");

    case "Write":
      return `\`\`\`\n${input.file_path}\n\`\`\`\n\n\`\`\`\n${truncate(String(input.content || ""), 1500)}\n\`\`\``;

    case "Edit": {
      const fp = String(input.file_path || "");
      const old = String(input.old_string || "");
      const nw = String(input.new_string || "");
      return `\`\`\`\n${fp}\n\`\`\`\n\n\`\`\`diff\n- ${truncate(old, 500).split("\n").join("\n- ")}\n+ ${truncate(nw, 500).split("\n").join("\n+ ")}\n\`\`\``;
    }

    case "Bash":
      return `\`\`\`bash\n${truncate(String(input.command || ""), 500)}\n\`\`\``;

    case "Glob":
      return `\`\`\`\n${input.pattern}\`\`\`` + (input.path ? ` in \`${input.path}\`` : "");

    case "Grep":
      return `\`${input.pattern}\`` +
        (input.path ? ` in \`${input.path}\`` : "") +
        (input.glob ? ` (${input.glob})` : "");

    case "Agent":
      return `*${input.description || "subagent"}*` +
        (input.subagent_type ? ` (${input.subagent_type})` : "");

    default: {
      const json = JSON.stringify(input, null, 2);
      if (json.length > 300) {
        return `\`\`\`json\n${truncate(json, 500)}\n\`\`\``;
      }
      return `\`\`\`json\n${json}\n\`\`\``;
    }
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

function fmtTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return ts;
  }
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}
