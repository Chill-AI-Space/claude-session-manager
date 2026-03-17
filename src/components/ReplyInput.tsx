"use client";

import { useState, useRef, forwardRef, useImperativeHandle, useEffect } from "react";

interface ReplyInputProps {
  sessionId: string;
  onSend: (message: string) => void;
  queueSize?: number;
  isStreaming?: boolean;
  bgClassName?: string;
  placeholder?: string;
}

export interface ReplyInputHandle {
  focus: () => void;
  getText: () => string;
  setText: (text: string) => void;
  triggerAttach: () => void;
  triggerSend: () => void;
}

export const ReplyInput = forwardRef<ReplyInputHandle, ReplyInputProps>(
function ReplyInput({ sessionId, onSend, queueSize = 0, isStreaming = false, bgClassName, placeholder: customPlaceholder }: ReplyInputProps, ref) {
  const draftKey = `reply_draft_${sessionId}`;
  const [message, setMessage] = useState(() => {
    if (typeof window !== "undefined") return localStorage.getItem(draftKey) ?? "";
    return "";
  });
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSendRef = useRef(() => {});
  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    getText: () => message,
    setText: (text: string) => setMessage(text),
    triggerAttach: () => fileInputRef.current?.click(),
    triggerSend: () => handleSendRef.current(),
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
  handleSendRef.current = handleSend;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
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

  const defaultBg = isDragging ? "border-ring border-dashed bg-muted/40" : "border-input bg-background";
  const containerBg = isDragging ? "border-ring border-dashed bg-muted/40" : (bgClassName || defaultBg);

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

      <div className={`relative rounded-lg border transition-colors ${containerBg}`}>
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
            customPlaceholder
              ? customPlaceholder
              : queueSize > 0
                ? `${queueSize} queued — type next...`
                : "Reply to Claude…"
          }
          rows={16}
          className="w-full resize-none bg-transparent rounded-lg px-3 py-2.5 text-[13px] placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>
    </div>
  );
});
