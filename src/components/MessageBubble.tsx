"use client";

import { ParsedMessage, ContentBlock } from "@/lib/types";
import { ToolUseBlock } from "./ToolUseBlock";
import { ThinkingBlock } from "./ThinkingBlock";
import { MarkdownContent } from "./MarkdownContent";
import { Zap, Bell, Scissors } from "lucide-react";
import { memo } from "react";

interface MessageBubbleProps {
  message: ParsedMessage;
  projectPath?: string;
}

function formatTime(ts: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Extract summary from <task-notification> XML block */
function extractTaskNotification(text: string): string | null {
  if (!text.includes("<task-notification>")) return null;
  const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch) return summaryMatch[1].trim();
  // Fallback: strip all XML tags and return cleaned text
  const cleaned = text.replace(/<[^>]+>/g, "").trim();
  return cleaned || null;
}

/** Check if text is purely a task-notification (no other user content) */
function isTaskNotificationOnly(text: string): boolean {
  const stripped = text.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "").trim();
  return stripped.length === 0 && text.includes("<task-notification>");
}

const NO_RESPONSE_PATTERNS = [
  /^no response requested\.?$/i,
  /^no response needed\.?$/i,
];

const CONTEXT_SUMMARY_PREFIX = "This session is being continued from a previous conversation that ran out of context.";

export const MessageBubble = memo(function MessageBubble({ message, projectPath }: MessageBubbleProps) {
  const isUser = message.type === "user";
  const content = message.content;

  const textBlocks: string[] = [];
  const toolUseBlocks: ContentBlock[] = [];
  const toolResultBlocks: ContentBlock[] = [];
  const thinkingBlocks: string[] = [];

  if (typeof content === "string") {
    textBlocks.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "text" && block.text) {
        textBlocks.push(block.text);
      } else if (block.type === "tool_use") {
        toolUseBlocks.push(block);
      } else if (block.type === "tool_result") {
        toolResultBlocks.push(block);
      } else if (block.type === "thinking" && block.thinking) {
        thinkingBlocks.push(block.thinking);
      }
    }
  }

  const hasText = textBlocks.some((t) => t.trim());
  const hasTools = toolUseBlocks.length > 0;
  const hasToolResults = toolResultBlocks.length > 0;
  const hasThinking = thinkingBlocks.length > 0;

  // Detect Claude Code's auto-generated context summary (injected as user message)
  const fullText = textBlocks.join("");
  if (isUser && fullText.trimStart().startsWith(CONTEXT_SUMMARY_PREFIX)) {
    return (
      <div className="flex items-center gap-3 py-1">
        <div className="flex-1 h-px bg-amber-500/20" />
        <div className="flex items-center gap-1.5 text-[11px] text-amber-600/70 dark:text-amber-400/60 shrink-0 bg-amber-50 dark:bg-amber-950/30 border border-amber-200/40 dark:border-amber-700/30 rounded-full px-2.5 py-0.5">
          <Scissors className="h-2.5 w-2.5" />
          <span>Context compacted — summary injected</span>
        </div>
        <div className="flex-1 h-px bg-amber-500/20" />
      </div>
    );
  }

  // Detect <task-notification> messages — render as compact status pill
  if (isUser && isTaskNotificationOnly(fullText)) {
    const summary = extractTaskNotification(fullText);
    if (summary) {
      return (
        <div className="flex items-center gap-3 py-1">
          <div className="flex-1 h-px bg-blue-500/20" />
          <div className="flex items-center gap-1.5 text-[11px] text-blue-600/70 dark:text-blue-400/60 shrink-0 bg-blue-50 dark:bg-blue-950/30 border border-blue-200/40 dark:border-blue-700/30 rounded-full px-2.5 py-0.5 max-w-[80%]">
            <Bell className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{summary}</span>
          </div>
          <div className="flex-1 h-px bg-blue-500/20" />
        </div>
      );
    }
  }

  // Hide "No response requested" assistant messages
  if (!isUser && hasText && !hasTools && !hasThinking) {
    const trimmed = fullText.trim();
    if (NO_RESPONSE_PATTERNS.some((p) => p.test(trimmed))) {
      return null;
    }
  }

  // Skip empty messages and tool-result-only user messages
  if (!hasText && !hasTools && !hasThinking) {
    if (isUser && hasToolResults) {
      return (
        <div className="space-y-1.5">
          {toolResultBlocks.map((block, i) => {
            if (block.type !== "tool_result") return null;
            const resultContent =
              typeof block.content === "string"
                ? block.content
                : Array.isArray(block.content)
                  ? block.content
                      .filter(
                        (b): b is { type: "text"; text: string } =>
                          b.type === "text"
                      )
                      .map((b) => b.text)
                      .join("")
                  : "";
            if (!resultContent.trim()) return null;
            return (
              <div
                key={i}
                className="ml-6 px-3 py-2 rounded bg-muted/40 text-xs font-mono text-muted-foreground max-h-[200px] overflow-y-auto whitespace-pre-wrap break-all"
              >
                {resultContent.slice(0, 2000)}
                {resultContent.length > 2000 && "..."}
              </div>
            );
          })}
        </div>
      );
    }
    return null;
  }

  // ── User message — right-aligned bubble, time inside (Telegram-style) ─────
  if (isUser) {
    const ts = formatTime(message.timestamp);
    // Strip any embedded <task-notification> blocks from user text
    const userText = textBlocks.join("\n").replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "").trim();
    if (!userText && !hasToolResults) return null;
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%]">
          <div className="bg-primary/8 dark:bg-primary/15 border border-primary/15 dark:border-primary/20 rounded-2xl rounded-tr-sm px-3.5 py-2 text-[13px] leading-relaxed">
            <div className="flex items-end gap-3">
              <div className="min-w-0 flex-1">
                {userText && <MarkdownContent content={userText} projectPath={projectPath} />}
                {hasToolResults && toolResultBlocks.map((block, i) => {
                  if (block.type !== "tool_result") return null;
                  const rc = typeof block.content === "string" ? block.content
                    : Array.isArray(block.content) ? block.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map(b => b.text).join("") : "";
                  return rc.trim() ? (
                    <div key={i} className="mt-1.5 text-xs font-mono text-muted-foreground bg-background/50 rounded px-2 py-1 max-h-[120px] overflow-y-auto whitespace-pre-wrap break-all">
                      {rc.slice(0, 2000)}{rc.length > 2000 && "..."}
                    </div>
                  ) : null;
                })}
              </div>
              {ts && <span className="shrink-0 text-[10px] text-muted-foreground/50 leading-none pb-0.5">{ts}</span>}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Claude message — left-aligned ───────────────────────────────────────────
  return (
    <div>
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/80">Claude</span>
          <span>{formatTime(message.timestamp)}</span>
          {message.model && (
            <span className="text-[10px] text-muted-foreground/60">
              {message.model.replace("claude-", "")}
            </span>
          )}
          {message.usage && (
            <span className="text-[10px] flex items-center gap-0.5 text-muted-foreground/60">
              <Zap className="h-2.5 w-2.5" />
              {message.usage.output_tokens.toLocaleString()}
            </span>
          )}
        </div>

        {hasThinking &&
          thinkingBlocks.map((thinking, i) => (
            <ThinkingBlock key={`thinking-${i}`} content={thinking} />
          ))}

        {hasText && (
          <div className="text-[13.5px] leading-[1.7]">
            <MarkdownContent content={textBlocks.join("")} projectPath={projectPath} />
          </div>
        )}

        {hasTools &&
          toolUseBlocks.map((block, i) => {
            if (block.type !== "tool_use") return null;
            const matchingResult = toolResultBlocks.find(
              (r) => r.type === "tool_result" && r.tool_use_id === block.id
            );
            let resultContent: string | undefined;
            if (matchingResult && matchingResult.type === "tool_result") {
              resultContent = typeof matchingResult.content === "string" ? matchingResult.content : "";
            }
            return (
              <ToolUseBlock
                key={block.id || i}
                name={block.name}
                input={block.input}
                result={resultContent}
              />
            );
          })}
      </div>
    </div>
  );
});
