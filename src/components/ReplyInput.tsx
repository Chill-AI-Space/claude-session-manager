"use client";

import { useState, useRef, forwardRef, useImperativeHandle, useEffect } from "react";
import { Send, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ReplyInputProps {
  sessionId: string;
  onSend: (message: string) => void;
  queueSize?: number;
  isStreaming?: boolean;
}

export interface ReplyInputHandle {
  focus: () => void;
  getText: () => string;
  setText: (text: string) => void;
}

export const ReplyInput = forwardRef<ReplyInputHandle, ReplyInputProps>(
function ReplyInput({ sessionId, onSend, queueSize = 0, isStreaming = false }: ReplyInputProps, ref) {
  const draftKey = `reply_draft_${sessionId}`;
  const [message, setMessage] = useState(() => {
    if (typeof window !== "undefined") return localStorage.getItem(draftKey) ?? "";
    return "";
  });
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    getText: () => message,
    setText: (text: string) => setMessage(text),
  }));
  const dragCounterRef = useRef(0);

  // Persist draft on every change
  useEffect(() => {
    if (message) {
      localStorage.setItem(draftKey, message);
    } else {
      localStorage.removeItem(draftKey);
    }
  }, [message, draftKey]);

  const insertAtCursor = (text: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = message.slice(0, start);
    const after = message.slice(end);
    const separator = before && !before.endsWith("\n") ? "\n" : "";
    const newVal = before + separator + text + after;
    setMessage(newVal);
    requestAnimationFrame(() => {
      const pos = start + separator.length + text.length;
      textarea.setSelectionRange(pos, pos);
      textarea.focus();
    });
  };

  const handleFiles = async (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;

    for (const file of files) {
      const fd = new FormData();
      fd.append("file", file);
      try {
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const data = await res.json();
        if (data.path) {
          insertAtCursor(data.path);
        } else {
          insertAtCursor(file.name);
        }
      } catch {
        insertAtCursor(file.name);
      }
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragging(false);
    handleFiles(e);
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragging(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  };

  const handleSend = () => {
    if (!message.trim()) return;
    onSend(message.trim());
    setMessage("");
    localStorage.removeItem(draftKey);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFileClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    for (const file of files) {
      const fd = new FormData();
      fd.append("file", file);
      try {
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const data = await res.json();
        insertAtCursor(data.path || file.name);
      } catch {
        insertAtCursor(file.name);
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div
      className="flex flex-col gap-1.5"
      onDrop={handleDrop}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
    >
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        multiple
        onChange={handleFileInput}
      />

      <div className={`relative rounded-lg border transition-colors ${isDragging ? "border-ring border-dashed bg-muted/40" : "border-input bg-background"}`}>
        {/* Drop overlay */}
        {isDragging && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-muted/60 pointer-events-none">
            <span className="text-xs text-muted-foreground font-medium">Drop to attach</span>
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            queueSize > 0
              ? `${queueSize} queued — type next...`
              : "Reply to Claude…"
          }
          rows={16}
          className="w-full resize-none bg-transparent rounded-lg px-3 py-2.5 pb-9 text-[13px] placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
        />

        {/* Bottom bar: attach + send */}
        <div className="absolute bottom-1.5 left-1.5 right-1.5 flex items-center justify-between">
          <button
            onClick={handleFileClick}
            className="flex items-center gap-1 text-[11px] text-muted-foreground/50 hover:text-muted-foreground transition-colors px-1.5 py-0.5 rounded hover:bg-muted/50"
            title="Attach file or drag & drop"
            type="button"
          >
            <Paperclip className="h-3 w-3" />
            <span>Attach</span>
          </button>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={handleSend}
            disabled={!message.trim()}
          >
            <Send className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
});
