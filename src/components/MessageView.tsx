"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { ParsedMessage, ContentBlock } from "@/lib/types";
import { MessageBubble } from "./MessageBubble";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MarkdownContent } from "./MarkdownContent";
import { Loader2, Scissors, ChevronRight, ChevronDown } from "lucide-react";

interface MessageViewProps {
  messages: ParsedMessage[];
  sessionId: string;
  streamingText?: string;
  isStreaming?: boolean;
  streamError?: string | null;
  highlightId?: string | null;
  highlightQuery?: string;
  folded?: boolean;
  projectPath?: string;
  onLoadEarlier?: () => void;
  loadingEarlier?: boolean;
}

/** Extract a short preview text from a message's content */
function getMessagePreview(msg: ParsedMessage): string {
  const content = msg.content;
  if (typeof content === "string") return content.split("\n")[0].trim().slice(0, 120);
  if (Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if (block.type === "text" && block.text?.trim()) {
        return block.text.split("\n")[0].trim().slice(0, 120);
      }
    }
    // fallback: tool use
    for (const block of content as ContentBlock[]) {
      if (block.type === "tool_use" && block.name) return `[${block.name}]`;
    }
  }
  return "";
}

function FoldableClaudeMessage({ msg, highlight, projectPath }: { msg: ParsedMessage; highlight: boolean; projectPath?: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = getMessagePreview(msg);

  return (
    <div
      data-uuid={msg.uuid}
      className={highlight ? "rounded-lg ring-2 ring-amber-400/70 ring-offset-2 ring-offset-background" : undefined}
    >
      {expanded ? (
        <div>
          {/* Collapse bar */}
          <button
            onClick={() => setExpanded(false)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground/50 hover:text-muted-foreground mb-1 w-full text-left"
          >
            <ChevronDown className="h-3 w-3" />
            <span className="truncate">{preview || "Claude response"}</span>
          </button>
          <MessageBubble message={msg} projectPath={projectPath} />
        </div>
      ) : (
        <button
          onClick={() => setExpanded(true)}
          className="flex items-center gap-2 w-full text-left group py-0.5"
        >
          <ChevronRight className="h-3 w-3 text-muted-foreground/30 group-hover:text-muted-foreground/60 shrink-0 transition-colors" />
          <span className="text-xs text-muted-foreground/50 group-hover:text-muted-foreground/80 truncate transition-colors">
            {preview || "Claude response"}
          </span>
        </button>
      )}
    </div>
  );
}

export function MessageView({
  messages,
  sessionId,
  streamingText,
  isStreaming,
  streamError,
  highlightId,
  highlightQuery,
  folded = false,
  projectPath,
  onLoadEarlier,
  loadingEarlier,
}: MessageViewProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const isNearBottomRef = useRef(true);

  // Track whether user is scrolled near the bottom of the viewport
  useEffect(() => {
    const root = scrollAreaRef.current;
    if (!root) return;
    const viewport = root.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']");
    if (!viewport) return;

    const THRESHOLD = 150; // px from bottom
    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = viewport;
      isNearBottomRef.current = scrollHeight - scrollTop - clientHeight < THRESHOLD;
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [sessionId]);

  // Auto-load earlier messages when scrolling to the top
  const onLoadEarlierRef = useRef(onLoadEarlier);
  onLoadEarlierRef.current = onLoadEarlier;
  useEffect(() => {
    loadingRef.current = !!loadingEarlier;
  }, [loadingEarlier]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !onLoadEarlierRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loadingRef.current && onLoadEarlierRef.current) {
          onLoadEarlierRef.current();
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sessionId, onLoadEarlier]);

  // Scroll to bottom on session switch (always)
  useEffect(() => {
    isNearBottomRef.current = true;
    bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [sessionId]);

  // Scroll to bottom when streaming or when new messages arrive — only if user is near bottom
  const prevCountRef = useRef(messages.length);
  useEffect(() => {
    const grew = messages.length > prevCountRef.current;
    prevCountRef.current = messages.length;
    if (!isNearBottomRef.current) return;
    if (streamingText || isStreaming || grew) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [streamingText, isStreaming, messages.length]);

  useEffect(() => {
    if (!highlightId) return;
    const el = containerRef.current?.querySelector(`[data-uuid="${CSS.escape(highlightId)}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightId, messages.length]);

  if (messages.length === 0 && !isStreaming) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        No messages in this session
      </div>
    );
  }

  return (
    <ScrollArea ref={scrollAreaRef} className="flex-1 min-h-0">
      <div ref={containerRef} className={`px-8 py-6 w-full max-w-[640px] mx-auto overflow-x-hidden ${folded ? "space-y-2" : "space-y-6"}`}>
        {/* Invisible sentinel — triggers auto-load when scrolled into view */}
        {onLoadEarlier && (
          <div ref={sentinelRef} className="h-px" />
        )}
        {loadingEarlier && (
          <div className="flex justify-center py-2">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/50" />
          </div>
        )}
        {messages.map((msg, i) => {
          if (msg.type === "compact_boundary") {
            const meta = msg.compactMetadata;
            return (
              <div key={msg.uuid || i} className="flex items-center gap-3 py-1">
                <div className="flex-1 h-px bg-amber-500/20" />
                <div className="flex items-center gap-1.5 text-[11px] text-amber-600/70 dark:text-amber-400/60 shrink-0 bg-amber-50 dark:bg-amber-950/30 border border-amber-200/40 dark:border-amber-700/30 rounded-full px-2.5 py-0.5">
                  <Scissors className="h-2.5 w-2.5" />
                  <span>Context compacted</span>
                  {meta?.trigger && <span className="opacity-60">· {meta.trigger}</span>}
                </div>
                <div className="flex-1 h-px bg-amber-500/20" />
              </div>
            );
          }

          const isHighlighted = !!(highlightId && msg.uuid === highlightId);

          // In folded mode, collapse assistant messages (except the last one)
          if (folded && msg.type === "assistant") {
            const isLastAssistant = messages.slice(i + 1).every((m) => m.type !== "assistant");
            if (!isLastAssistant) {
              return (
                <FoldableClaudeMessage
                  key={msg.uuid || i}
                  msg={msg}
                  highlight={isHighlighted}
                  projectPath={projectPath}
                />
              );
            }
          }

          return (
            <div
              key={msg.uuid || i}
              data-uuid={msg.uuid}
              className={
                isHighlighted
                  ? "rounded-lg ring-2 ring-amber-400/70 ring-offset-2 ring-offset-background transition-all"
                  : undefined
              }
            >
              <MessageBubble message={msg} projectPath={projectPath} />
            </div>
          );
        })}

        {isStreaming && (
          <div>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground/80">Claude</span>
                {!streamingText && !streamError && (
                  <span className="flex items-center gap-1.5 text-muted-foreground/60">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    thinking...
                  </span>
                )}
              </div>
              {streamingText && (
                <div className="text-[13px] leading-relaxed">
                  <MarkdownContent content={streamingText} projectPath={projectPath} />
                </div>
              )}
              {streamError && (
                <div className="text-sm text-destructive">{streamError}</div>
              )}
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}
