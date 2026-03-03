"use client";

import { useEffect, useState, useCallback, useRef, use } from "react";
import { useRouter } from "next/navigation";
import { MessageView } from "@/components/MessageView";
import { ReplyInput } from "@/components/ReplyInput";
import { ParsedMessage, SessionRow } from "@/lib/types";
import { Loader2, GitBranch, Hash, Zap, Terminal, X, Settings } from "lucide-react";
import { formatTokens } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";
import Link from "next/link";

interface SessionDetailData {
  session_id: string;
  project_path: string;
  messages: ParsedMessage[];
  metadata: SessionRow;
  is_active: boolean;
}

export default function SessionDetailPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = use(params);
  const router = useRouter();
  const [data, setData] = useState<SessionDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // All pending/streaming messages shown below the server data
  const [extraMessages, setExtraMessages] = useState<ParsedMessage[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);

  // Message queue: messages waiting to be sent
  const queueRef = useRef<string[]>([]);
  const processingRef = useRef(false);
  // Abort controller for cancelling in-flight requests on session switch
  const abortRef = useRef<AbortController | null>(null);

  // Track if we've killed the terminal for this session (to hide the button)
  const [terminalKilled, setTerminalKilled] = useState(false);
  // Track if user has replied at least once
  const [hasReplied, setHasReplied] = useState(false);

  // Settings for status bar
  const [settings, setSettingsData] = useState<Record<string, string> | null>(null);

  const fetchSession = useCallback(async ({ clearExtras = false } = {}) => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}`);
      if (!res.ok) {
        setError("Session not found");
        return;
      }
      const json = await res.json();
      setData(json);
      if (clearExtras) {
        setExtraMessages([]);
      }
    } catch {
      setError("Failed to load session");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    // Abort any in-flight streaming request from previous session
    abortRef.current?.abort();
    abortRef.current = null;

    setLoading(true);
    setError(null);
    setExtraMessages([]);
    setStreamingText("");
    setIsStreaming(false);
    setStreamError(null);
    setTerminalKilled(false);
    setHasReplied(false);
    queueRef.current = [];
    processingRef.current = false;
    fetchSession();
    // Fetch settings for status bar
    fetch("/api/settings").then(r => r.json()).then(setSettingsData).catch(() => {});

    return () => {
      // Cleanup on unmount or session change
      abortRef.current?.abort();
    };
  }, [sessionId, fetchSession]);

  // Process next message in queue
  const processQueue = useCallback(async () => {
    if (processingRef.current) return;
    const message = queueRef.current.shift();
    if (!message) return;

    processingRef.current = true;
    setHasReplied(true);

    // Add user message to extra messages
    const userMsg: ParsedMessage = {
      uuid: `pending-${Date.now()}`,
      type: "user",
      timestamp: new Date().toISOString(),
      content: message,
    };
    setExtraMessages((prev) => [...prev, userMsg]);
    setStreamingText("");
    setStreamError(null);
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`/api/sessions/${sessionId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json();
        setStreamError(err.error || "Failed to send");
        setIsStreaming(false);
        processingRef.current = false;
        processQueue();
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        setStreamError("No response stream");
        setIsStreaming(false);
        processingRef.current = false;
        processQueue();
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const evt = JSON.parse(line.slice(6));
              if (evt.type === "text" || evt.type === "chunk") {
                fullText += evt.text;
                setStreamingText(fullText);
              } else if (evt.type === "error") {
                setStreamError(evt.text);
              } else if (evt.type === "done") {
                if (evt.is_error) {
                  setStreamError(evt.result);
                }
              }
            } catch {
              // ignore parse errors
            }
          }
        }
      }

      // Stream finished — bake the assistant response into extraMessages
      if (fullText) {
        const assistantMsg: ParsedMessage = {
          uuid: `reply-${Date.now()}`,
          type: "assistant",
          timestamp: new Date().toISOString(),
          content: fullText,
        };
        setExtraMessages((prev) => [...prev, assistantMsg]);
      }
      setStreamingText("");
      setStreamError(null);

      // Re-fetch canonical data; clear extras only after server data arrives
      fetchSession({ clearExtras: true });
    } catch (err) {
      // Don't show error if request was aborted (session switch)
      if (err instanceof DOMException && err.name === "AbortError") return;
      // Bake error into extraMessages so it persists after streaming ends
      const errorMsg: ParsedMessage = {
        uuid: `error-${Date.now()}`,
        type: "assistant",
        timestamp: new Date().toISOString(),
        content: "Failed to send message",
      };
      setExtraMessages((prev) => [...prev, errorMsg]);
      setStreamError(null);
    } finally {
      setIsStreaming(false);
      processingRef.current = false;
      // Process next queued message
      processQueue();
    }
  }, [sessionId, fetchSession]);

  const handleSend = (message: string) => {
    queueRef.current.push(message);
    processQueue();
  };

  // Redirect to session list if session not found (must be before any conditional returns)
  useEffect(() => {
    if (!loading && (error || !data)) {
      router.replace("/claude-sessions");
    }
  }, [loading, error, data, router]);

  if (loading || error || !data) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const totalTokens =
    data.metadata.total_input_tokens + data.metadata.total_output_tokens;


  const killTerminal = async () => {
    try {
      await fetch(`/api/sessions/${sessionId}/kill`, { method: "POST" });
      setTerminalKilled(true);
    } catch {
      // ignore
    }
  };

  const openInTerminal = async () => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/open`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = await res.json();
        alert(`Failed to open: ${err.error}`);
      }
    } catch {
      alert("Failed to open terminal");
    }
  };

  // Combine server messages + extra (optimistic user + streaming assistant)
  // Extras are cleared after each successful reply, so no duplication
  const allMessages = [...data.messages, ...extraMessages];

  const queueSize = queueRef.current.length;

  return (
    <>
      {/* Session header */}
      <div className="border-b border-border px-4 py-3 flex items-center gap-3 min-h-[52px] shrink-0">
        <StatusBadge active={data.is_active} />
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-medium truncate">
            {data.metadata.custom_name ||
              data.metadata.first_prompt?.slice(0, 100) ||
              data.session_id.slice(0, 8)}
          </h2>
          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
            <span className="truncate">
              {data.project_path.split("/").pop()}
            </span>
            {data.metadata.git_branch && data.metadata.git_branch !== "HEAD" && (
              <span className="flex items-center gap-1 shrink-0">
                <GitBranch className="h-3 w-3" />
                {data.metadata.git_branch}
              </span>
            )}
            <span className="flex items-center gap-1 shrink-0">
              <Hash className="h-3 w-3" />
              {data.metadata.message_count}
            </span>
            {totalTokens > 0 && (
              <span className="flex items-center gap-1 shrink-0">
                <Zap className="h-3 w-3" />
                {formatTokens(totalTokens)}
              </span>
            )}
            {data.metadata.model && (
              <Badge variant="secondary" className="text-[10px] h-4 px-1.5 shrink-0">
                {data.metadata.model.replace("claude-", "")}
              </Badge>
            )}
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 gap-1.5 text-xs h-7"
          onClick={openInTerminal}
        >
          <Terminal className="h-3.5 w-3.5" />
          Open in Terminal
        </Button>
      </div>

      {/* Messages */}
      <MessageView
        messages={allMessages}
        sessionId={data.session_id}
        streamingText={streamingText}
        isStreaming={isStreaming}
        streamError={streamError}
      />

      {/* Kill terminal banner — shown when auto-kill is off and user has replied */}
      {hasReplied && !terminalKilled && data.is_active && (
        <div className="flex items-center gap-2 px-4 py-2 border-t border-border bg-muted/50 text-xs text-muted-foreground shrink-0">
          <Terminal className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">
            This session is still running in a terminal — replies may diverge.
          </span>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 gap-1.5 text-xs h-7"
            onClick={killTerminal}
          >
            <X className="h-3 w-3" />
            Close terminal session
          </Button>
        </div>
      )}

      {/* Reply input — always enabled, queues messages */}
      <ReplyInput
        sessionId={data.session_id}
        onSend={handleSend}
        queueSize={queueSize}
      />

      {/* Active settings status bar */}
      {settings && (() => {
        const SETTING_LABELS: Record<string, string> = {
          dangerously_skip_permissions: "Skip Permissions",
          auto_kill_terminal_on_reply: "Auto-Kill Terminal",
        };
        const enabled = Object.entries(settings)
          .filter(([, v]) => v === "true")
          .map(([k]) => SETTING_LABELS[k] || k);

        if (enabled.length === 0) return null;

        return (
          <div className="px-6 pb-4 pt-0 shrink-0 max-w-[900px]">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground/60">
              <span>
                {enabled.join(", ")}
              </span>
              <Link
                href="/claude-sessions/settings"
                className="flex items-center gap-1 hover:text-muted-foreground transition-colors"
                title="Settings"
              >
                <Settings className="h-3 w-3" />
              </Link>
            </div>
          </div>
        );
      })()}
    </>
  );
}
