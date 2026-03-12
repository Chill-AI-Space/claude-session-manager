import fs from "fs";
import { ParsedMessage, ContentBlock } from "./types";

export function readSessionMessages(
  jsonlPath: string,
  options?: { limit?: number; offset?: number }
): ParsedMessage[] {
  if (!fs.existsSync(jsonlPath)) {
    return [];
  }

  const content = fs.readFileSync(jsonlPath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());
  const messages: ParsedMessage[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);

      if (obj.type === "system" && obj.subtype === "compact_boundary") {
        messages.push({
          uuid: obj.uuid || "",
          type: "compact_boundary",
          timestamp: obj.timestamp || "",
          content: obj.content || "Conversation compacted",
          compactMetadata: obj.compactMetadata,
        });
      } else if (obj.type === "user" && obj.message?.role === "user") {
        // Skip tool_result-only messages (they're part of assistant flow)
        const content = obj.message.content;
        const isToolResultOnly =
          Array.isArray(content) &&
          content.every(
            (b: { type: string }) =>
              b.type === "tool_result"
          );
        if (isToolResultOnly) continue;

        messages.push({
          uuid: obj.uuid || obj.messageId || "",
          type: "user",
          timestamp: obj.timestamp || "",
          content: obj.message.content,
          git_branch: obj.gitBranch,
          cwd: obj.cwd,
        });
      } else if (
        obj.type === "assistant" &&
        obj.message?.role === "assistant"
      ) {
        messages.push({
          uuid: obj.uuid || "",
          type: "assistant",
          timestamp: obj.timestamp || "",
          content: obj.message.content || [],
          model: obj.message.model,
          usage: obj.message.usage
            ? {
                input_tokens: obj.message.usage.input_tokens || 0,
                output_tokens: obj.message.usage.output_tokens || 0,
                cache_read_input_tokens:
                  obj.message.usage.cache_read_input_tokens || 0,
                cache_creation_input_tokens:
                  obj.message.usage.cache_creation_input_tokens || 0,
              }
            : undefined,
          git_branch: obj.gitBranch,
          cwd: obj.cwd,
        });
      }
    } catch {
      // skip malformed lines
    }
  }

  // Merge consecutive assistant messages (streaming chunks)
  const merged = mergeConsecutiveAssistant(messages);

  // Apply offset and limit
  if (options?.offset || options?.limit) {
    const start = options.offset || 0;
    const end = options.limit ? start + options.limit : undefined;
    return merged.slice(start, end);
  }

  return merged;
}

function mergeConsecutiveAssistant(
  messages: ParsedMessage[]
): ParsedMessage[] {
  const result: ParsedMessage[] = [];

  for (const msg of messages) {
    const last = result[result.length - 1];

    if (
      msg.type === "assistant" &&
      last?.type === "assistant" &&
      msg.uuid === last.uuid
    ) {
      // Same assistant message ID — merge content
      if (Array.isArray(last.content) && Array.isArray(msg.content)) {
        last.content = [...last.content, ...msg.content];
      }
      // Keep the latest usage stats
      if (msg.usage) {
        last.usage = msg.usage;
      }
      if (msg.model) {
        last.model = msg.model;
      }
    } else {
      result.push({ ...msg });
    }
  }

  return result;
}

/**
 * Convert parsed messages to plain text with role prefixes.
 * Useful for context extraction, export, and AI prompts.
 */
export function messagesToText(
  messages: ParsedMessage[],
  opts?: { roleLabels?: { user: string; assistant: string }; maxMessageLen?: number }
): string {
  const labels = opts?.roleLabels ?? { user: "USER", assistant: "CLAUDE" };
  const maxLen = opts?.maxMessageLen ?? 0;
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.type === "compact_boundary") continue;

    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter((b): b is ContentBlock & { type: "text"; text: string } => b.type === "text" && !!b.text)
        .map((b) => b.text)
        .join("\n");
    }

    if (!text.trim()) continue;
    if (maxLen > 0 && text.length > maxLen) text = text.slice(0, maxLen) + "...";

    const label = msg.type === "user" ? labels.user : labels.assistant;
    parts.push(`${label}: ${text.trim()}`);
  }

  return parts.join("\n\n");
}

export function getSessionMessageCount(jsonlPath: string): number {
  if (!fs.existsSync(jsonlPath)) return 0;

  const content = fs.readFileSync(jsonlPath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());
  let count = 0;

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "user" || obj.type === "assistant") {
        count++;
      }
    } catch {
      // skip
    }
  }

  return count;
}
