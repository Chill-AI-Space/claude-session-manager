import fs from "fs";
import { ParsedMessage, ContentBlock } from "./types";
import { iterateLinesSync } from "./utils-server";

function extractToolResultBlocks(content: unknown): ContentBlock[] | null {
  if (!Array.isArray(content) || content.length === 0) return null;

  const blocks = content.filter(
    (b): b is { type: string; tool_use_id?: string; content?: string | ContentBlock[] } =>
      !!b && typeof b === "object" && "type" in b && (b as { type: string }).type === "tool_result"
  );

  if (blocks.length !== content.length) return null;

  return blocks.map((block) => ({
    type: "tool_result",
    tool_use_id: block.tool_use_id ?? "",
    content: block.content ?? "",
  }));
}

function appendToolResults(
  messages: ParsedMessage[],
  toolResults: ContentBlock[],
  fallbackTimestamp: string,
  fallbackUuid: string
): void {
  const last = messages[messages.length - 1];
  if (last?.type === "assistant" && Array.isArray(last.content)) {
    last.content = [...last.content, ...toolResults];
    return;
  }

  messages.push({
    uuid: fallbackUuid,
    type: "assistant",
    timestamp: fallbackTimestamp,
    content: toolResults,
  });
}

export function readSessionMessages(
  jsonlPath: string,
  options?: { limit?: number; offset?: number }
): ParsedMessage[] {
  if (!fs.existsSync(jsonlPath)) {
    return [];
  }

  const messages = parseLines(iterateLinesSync(jsonlPath));

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

/**
 * Optimized reader: counts total messages without building full objects,
 * then only parses the requested page. Avoids O(N) object allocations
 * for sessions with thousands of messages.
 */
export function readSessionMessagesPaginated(
  jsonlPath: string,
  opts: { pageSize: number; before?: number }
): { messages: ParsedMessage[]; total: number; start: number } {
  if (!fs.existsSync(jsonlPath)) {
    return { messages: [], total: 0, start: 0 };
  }

  const pageSize = opts.pageSize;
  const allMessages: ParsedMessage[] = [];

  // Stream lines and parse into messages
  for (const line of iterateLinesSync(jsonlPath)) {
    try {
      const obj = JSON.parse(line);
      let msg: ParsedMessage | null = null;

      if (obj.type === "system" && obj.subtype === "compact_boundary") {
        msg = {
          uuid: obj.uuid || "",
          type: "compact_boundary",
          timestamp: obj.timestamp || "",
          content: obj.content || "Conversation compacted",
          compactMetadata: obj.compactMetadata,
        };
      } else if (obj.type === "user" && obj.message?.role === "user") {
        if (obj.isMeta) continue;
        const content = obj.message.content;
        const toolResults = extractToolResultBlocks(content);
        if (toolResults) {
          appendToolResults(
            allMessages,
            toolResults,
            obj.timestamp || "",
            obj.uuid || obj.messageId || ""
          );
          continue;
        }

        msg = {
          uuid: obj.uuid || obj.messageId || "",
          type: "user",
          timestamp: obj.timestamp || "",
          content: obj.message.content,
          git_branch: obj.gitBranch,
          cwd: obj.cwd,
        };
      } else if (obj.type === "assistant" && obj.message?.role === "assistant") {
        msg = {
          uuid: obj.uuid || "",
          type: "assistant",
          timestamp: obj.timestamp || "",
          content: obj.message.content || [],
          model: obj.message.model,
          usage: obj.message.usage ? {
            input_tokens: obj.message.usage.input_tokens || 0,
            output_tokens: obj.message.usage.output_tokens || 0,
            cache_read_input_tokens: obj.message.usage.cache_read_input_tokens || 0,
            cache_creation_input_tokens: obj.message.usage.cache_creation_input_tokens || 0,
          } : undefined,
          git_branch: obj.gitBranch,
          cwd: obj.cwd,
        };
      }

      if (msg) {
        // Merge logic
        const last = allMessages[allMessages.length - 1];
        if (msg.type === "assistant" && last?.type === "assistant" && msg.uuid === last.uuid) {
          if (Array.isArray(last.content) && Array.isArray(msg.content)) {
            last.content = [...last.content, ...msg.content];
          }
          if (msg.usage) last.usage = msg.usage;
          if (msg.model) last.model = msg.model;
        } else {
          allMessages.push(msg);
        }
      }
    } catch { /* skip */ }
  }

  const total = allMessages.length;
  const before = opts.before ?? total;
  const start = Math.max(0, before - pageSize);
  return {
    messages: allMessages.slice(start, before),
    total,
    start,
  };
}

function parseLines(lines: Iterable<string>): ParsedMessage[] {
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
        // Skip SDK meta-messages ("Continue from where you left off." injected on --resume)
        if (obj.isMeta) continue;
        const content = obj.message.content;
        const toolResults = extractToolResultBlocks(content);
        if (toolResults) {
          appendToolResults(
            messages,
            toolResults,
            obj.timestamp || "",
            obj.uuid || obj.messageId || ""
          );
          continue;
        }

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
  return messages;
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

  let count = 0;
  for (const line of iterateLinesSync(jsonlPath)) {
    try {
      if (line.includes('"type":"user"') || line.includes('"type":"assistant"')) {
        count++;
      }
    } catch { /* skip */ }
  }

  return count;
}
