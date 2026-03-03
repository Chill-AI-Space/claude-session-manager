"use client";

import { useRef, useEffect } from "react";
import { ParsedMessage } from "@/lib/types";
import { MessageBubble } from "./MessageBubble";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MarkdownContent } from "./MarkdownContent";
import { Loader2 } from "lucide-react";

interface MessageViewProps {
  messages: ParsedMessage[];
  sessionId: string;
  streamingText?: string;
  isStreaming?: boolean;
  streamError?: string | null;
}

export function MessageView({
  messages,
  sessionId,
  streamingText,
  isStreaming,
  streamError,
}: MessageViewProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom on session change and when streaming updates
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [sessionId]);

  useEffect(() => {
    if (streamingText || isStreaming) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [streamingText, isStreaming]);

  if (messages.length === 0 && !isStreaming) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        No messages in this session
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div className="px-6 py-5 space-y-5 max-w-[900px]">
        {messages.map((msg, i) => (
          <MessageBubble key={msg.uuid || i} message={msg} />
        ))}

        {/* Streaming assistant response */}
        {isStreaming && (
          <div className="flex gap-3">
            <div className="w-0.5 shrink-0 rounded-full mt-1 bg-orange-500/40" />
            <div className="flex-1 min-w-0 space-y-2">
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
                <div className="text-sm leading-relaxed">
                  <MarkdownContent content={streamingText} />
                </div>
              )}
              {streamError && (
                <div className="text-sm text-destructive">
                  {streamError}
                </div>
              )}
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}
