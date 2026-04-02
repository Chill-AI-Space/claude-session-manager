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
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  const messages = parseLines(lines);

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

  const content = fs.readFileSync(jsonlPath, "utf-8");
  const lines = content.split(/\r?\n/).filter((l) => l.trim());

  // Phase 1: lightweight count — only check type field, don't build objects.
  // Also track which raw lines are "message lines" (user/assistant/compact_boundary)
  // so we can map merged-message indices back to raw line indices.
  const msgLineIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Quick prefix checks to avoid JSON.parse on non-message lines
    if (line.includes('"type":"user"') || line.includes('"type":"assistant"') ||
        line.includes('"type":"system"')) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === "system" && obj.subtype === "compact_boundary") {
          msgLineIndices.push(i);
        } else if (obj.type === "user" && obj.message?.role === "user") {
          // Skip SDK meta-messages and tool_result-only
          if (obj.isMeta) continue;
          const c = obj.message.content;
          if (Array.isArray(c) && c.every((b: { type: string }) => b.type === "tool_result")) continue;
          msgLineIndices.push(i);
        } else if (obj.type === "assistant" && obj.message?.role === "assistant") {
          msgLineIndices.push(i);
        }
      } catch { /* skip */ }
    }
  }

  // Parse only the needed lines, then merge to get accurate count
  // For efficiency: parse a generous window, merge, then slice
  const totalRawMsgs = msgLineIndices.length;

  // We need to figure out the merged total. Since merging only affects
  // consecutive assistant messages with same UUID, we can estimate or
  // do a full merge. For accuracy, parse all lines (as before) for small files,
  // but for large files only parse a larger window.
  const LARGE_FILE_THRESHOLD = 500; // msg lines
  if (totalRawMsgs <= LARGE_FILE_THRESHOLD) {
    // Small file — parse everything (fast enough)
    const allMessages = parseLines(lines);
    const merged = mergeConsecutiveAssistant(allMessages);
    const total = merged.length;
    const before = opts.before ?? total;
    const start = Math.max(0, before - opts.pageSize);
    return { messages: merged.slice(start, before), total, start };
  }

  // Large file — parse all for merge accuracy but avoid building
  // full content objects for lines we won't return.
  // Lightweight parse: only build stubs for counting/merging, full parse for the window.
  const before = opts.before ?? totalRawMsgs; // approximate
  const windowStart = Math.max(0, before - opts.pageSize - 50); // extra margin for merging
  const windowEnd = Math.min(totalRawMsgs, before + 10);

  // Count merged messages before window (lightweight — just count UUIDs)
  let countBefore = 0;
  let prevUuid = "";
  let prevType = "";
  for (let i = 0; i < windowStart && i < msgLineIndices.length; i++) {
    try {
      const obj = JSON.parse(lines[msgLineIndices[i]]);
      const uuid = obj.uuid || obj.messageId || "";
      const type = obj.type === "assistant" ? "assistant" : "other";
      // Merge logic: same uuid + consecutive assistant = same message
      if (type === "assistant" && prevType === "assistant" && uuid === prevUuid) {
        // merged with previous — don't count
      } else {
        countBefore++;
      }
      prevUuid = uuid;
      prevType = type;
    } catch {
      countBefore++;
      prevUuid = "";
      prevType = "";
    }
  }

  // Full parse for the window
  const windowLines = [];
  for (let i = windowStart; i < windowEnd && i < msgLineIndices.length; i++) {
    windowLines.push(lines[msgLineIndices[i]]);
  }
  const windowMessages = parseLines(windowLines);
  const windowMerged = mergeConsecutiveAssistant(windowMessages);

  // Count merged messages after window
  let countAfter = 0;
  prevUuid = "";
  prevType = "";
  for (let i = windowEnd; i < msgLineIndices.length; i++) {
    try {
      const obj = JSON.parse(lines[msgLineIndices[i]]);
      const uuid = obj.uuid || obj.messageId || "";
      const type = obj.type === "assistant" ? "assistant" : "other";
      if (type === "assistant" && prevType === "assistant" && uuid === prevUuid) {
        // merged
      } else {
        countAfter++;
      }
      prevUuid = uuid;
      prevType = type;
    } catch {
      countAfter++;
      prevUuid = "";
      prevType = "";
    }
  }

  const total = countBefore + windowMerged.length + countAfter;
  const adjustedBefore = opts.before ?? total;
  const pageStart = Math.max(0, adjustedBefore - opts.pageSize) - countBefore;
  const pageEnd = adjustedBefore - countBefore;
  const messages = windowMerged.slice(
    Math.max(0, pageStart),
    Math.max(0, pageEnd)
  );

  return {
    messages,
    total,
    start: countBefore + Math.max(0, pageStart),
  };
}

function parseLines(lines: string[]): ParsedMessage[] {
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

  const content = fs.readFileSync(jsonlPath, "utf-8");
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
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
