"use client";

import { useState, useRef, forwardRef, useImperativeHandle, useEffect } from "react";
import { Mic, Square, Loader2 } from "lucide-react";

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
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [recordingSecs, setRecordingSecs] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleSendRef = useRef(() => {});
  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    getText: () => message,
    setText: (text: string) => setMessage(text),
    triggerAttach: () => fileInputRef.current?.click(),
    triggerSend: () => handleSendRef.current(),
  }));
  const dragCounterRef = useRef(0);

  // Stop the recording timer if the component unmounts mid-recording
  useEffect(() => {
    return () => {
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    };
  }, []);

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

    const paths: string[] = [];
    for (const file of files) {
      const fd = new FormData();
      fd.append("file", file);
      try {
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const data = await res.json();
        paths.push(data.path || file.name);
      } catch {
        paths.push(file.name);
      }
    }
    if (paths.length > 0) {
      insertAtCursor(paths.join("\n"));
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

  const startRecording = async () => {
    setRecordError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : undefined;
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        setIsTranscribing(true);
        try {
          const fd = new FormData();
          fd.append("audio", blob, "voice.webm");
          const res = await fetch("/api/transcribe", { method: "POST", body: fd });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Transcription failed");
          if (data.transcript) insertAtCursor(data.transcript);
        } catch (err) {
          setRecordError(err instanceof Error ? err.message : String(err));
        } finally {
          setIsTranscribing(false);
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
      setRecordingSecs(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingSecs((s) => s + 1);
      }, 1000);
    } catch (err) {
      setRecordError(err instanceof Error ? err.message : "Microphone access denied");
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
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
    if (e.key === "Enter" && (e.metaKey || e.altKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    const paths: string[] = [];
    for (const file of files) {
      const fd = new FormData();
      fd.append("file", file);
      try {
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const data = await res.json();
        paths.push(data.path || file.name);
      } catch {
        paths.push(file.name);
      }
    }
    if (paths.length > 0) {
      insertAtCursor(paths.join("\n"));
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
                : "Reply to Claude… (⌘Enter to send)"
          }
          rows={16}
          className="w-full resize-none bg-transparent rounded-lg px-3 py-2.5 pr-9 text-[13px] placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
        />

        {isRecording && (
          <span className="absolute bottom-2 right-9 flex items-center gap-1 text-[11px] tabular-nums text-red-500">
            <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
            {String(Math.floor(recordingSecs / 60)).padStart(1, "0")}:{String(recordingSecs % 60).padStart(2, "0")}
          </span>
        )}

        <button
          type="button"
          onClick={isRecording ? stopRecording : startRecording}
          disabled={isTranscribing}
          title={isRecording ? "Stop recording" : "Record voice message"}
          className={`absolute bottom-2 right-2 flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
            isRecording
              ? "bg-red-500/20 text-red-500 animate-pulse"
              : "text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50"
          }`}
        >
          {isTranscribing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : isRecording ? (
            <Square className="h-3 w-3 fill-current" />
          ) : (
            <Mic className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {recordError && <span className="text-[11px] text-red-500">{recordError}</span>}
    </div>
  );
});
