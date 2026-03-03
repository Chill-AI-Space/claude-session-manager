"use client";

import { ParsedMessage, ContentBlock } from "@/lib/types";
import { ToolUseBlock } from "./ToolUseBlock";
import { ThinkingBlock } from "./ThinkingBlock";
import { MarkdownContent } from "./MarkdownContent";
import { Zap } from "lucide-react";

interface MessageBubbleProps {
  message: ParsedMessage;
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

export function MessageBubble({ message }: MessageBubbleProps) {
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

  return (
    <div className="flex gap-3">
      {/* Role indicator — thin colored bar */}
      <div
        className={`w-0.5 shrink-0 rounded-full mt-1 ${
          isUser ? "bg-foreground/20" : "bg-orange-500/40"
        }`}
      />

      {/* Content */}
      <div className="flex-1 min-w-0 space-y-2">
        {/* Header */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/80">
            {isUser ? "You" : "Claude"}
          </span>
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

        {/* Thinking */}
        {hasThinking &&
          thinkingBlocks.map((thinking, i) => (
            <ThinkingBlock key={`thinking-${i}`} content={thinking} />
          ))}

        {/* Text content */}
        {hasText && (
          <div className="text-sm leading-relaxed">
            <MarkdownContent content={textBlocks.join("")} />
          </div>
        )}

        {/* Tool uses */}
        {hasTools &&
          toolUseBlocks.map((block, i) => {
            if (block.type !== "tool_use") return null;
            const matchingResult = toolResultBlocks.find(
              (r) =>
                r.type === "tool_result" &&
                r.tool_use_id === block.id
            );
            let resultContent: string | undefined;
            if (matchingResult && matchingResult.type === "tool_result") {
              resultContent =
                typeof matchingResult.content === "string"
                  ? matchingResult.content
                  : "";
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
}
