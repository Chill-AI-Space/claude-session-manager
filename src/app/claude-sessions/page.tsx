"use client";

import { useState, useRef, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { FolderBrowserDialog } from "@/components/FolderBrowserDialog";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { FolderOpen, Send, Loader2, FolderPlus, ShieldOff, Paperclip, Monitor, Cloud, Mic, Square } from "lucide-react";
import { AgentToggleButton, type AgentType } from "@/components/AgentToggleButton";
import { ModelSelector, getDefaultModelForAgent, getModelPresetsForAgent } from "@/components/settings/ModelSelector";
import { useSettings } from "@/lib/settings";
import { useAutodetect } from "@/hooks/useAutodetect";
import { useSessionStart } from "@/hooks/useSessionStart";
import { useSettingToggle } from "@/hooks/useSettingToggle";
import { useComputeNode } from "@/hooks/useComputeNode";

// The "+ New" button in the sidebar links here with a fresh `?new=<ts>` query
// each time so this remounts (and resets its draft state) even when you're
// already on this page — a plain same-URL <Link> is a no-op in the App Router.
export default function SessionsEmptyStatePage() {
  return (
    <Suspense fallback={null}>
      <SessionsEmptyStateWithParams />
    </Suspense>
  );
}

function SessionsEmptyStateWithParams() {
  const searchParams = useSearchParams();
  return <SessionsEmptyState key={searchParams.toString()} />;
}

function SessionsEmptyState() {
  const [message, setMessage] = useState("");
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [folderBrowserOpen, setFolderBrowserOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [recordingSecs, setRecordingSecs] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const skipPerms = useSettingToggle("dangerously_skip_permissions");
  const [selectedAgent, setSelectedAgent] = useState<AgentType>("codex");
  const [selectedModel, setSelectedModel] = useState<string | undefined>(undefined);
  const compute = useComputeNode();
  const autodetect = useAutodetect();
  const session = useSessionStart();
  const { settings } = useSettings();
  const effectiveSelectedModel = selectedModel || getDefaultModelForAgent(selectedAgent, settings.claude_model);

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

  useEffect(() => {
    return () => {
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    };
  }, []);

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

  const uploadFiles = async (files: File[]) => {
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
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragging(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) uploadFiles(files);
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

  const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) await uploadFiles(files);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const doStart = (path: string) => {
    session.start(path, message, { agent: selectedAgent, model: effectiveSelectedModel });
  };

  // Smart start: if folder known → start; else autodetect → start; else open picker
  const handleSmartStart = async () => {
    if (!message.trim() || session.starting || autodetect.detecting) return;
    if (folderPath) {
      doStart(folderPath);
      return;
    }
    const firstPath = await autodetect.detect(message);
    if (firstPath) {
      setFolderPath(firstPath);
      doStart(firstPath);
    } else if (autodetect.suggestions.length === 0) {
      setFolderBrowserOpen(true);
    }
    // if suggestions > 0, they're shown below and user clicks one to start
  };

  const isBusy = session.starting || autodetect.detecting;

  return (
    <div className="flex-1 flex items-center justify-center text-muted-foreground">
      <div className="w-full max-w-md space-y-4 px-6">
        <div className="text-center space-y-1">
          <p className="text-sm font-medium text-foreground">Select a session or start a new one</p>
          <p className="text-xs">Choose from the sidebar, or describe your task below</p>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          multiple
          onChange={handleFileInput}
        />
        <div
          className={`relative rounded-lg border bg-card shadow-sm transition-colors ${isDragging ? "border-ring border-dashed bg-muted/40" : "border-border"}`}
          onDrop={handleDrop}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
        >
          {isDragging && (
            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-muted/60 pointer-events-none">
              <span className="text-xs text-muted-foreground font-medium">Drop to attach</span>
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              if (autodetect.suggestions.length > 0) autodetect.clearSuggestions();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSmartStart();
              }
            }}
            placeholder={`What would you like ${selectedAgent === "forge" ? "Forge" : selectedAgent === "codex" ? "Codex" : "Claude"} to do? (⌘Enter to start)`}
            rows={5}
            className={`w-full resize-none bg-transparent rounded-lg px-3 py-2.5 text-[13px] placeholder:text-muted-foreground/50 focus:outline-none ${selectedAgent === "forge" ? "pb-16" : "pb-10"}`}
            disabled={isBusy}
          />
          <div className="absolute bottom-1.5 left-1.5 right-1.5 flex flex-col gap-1">
            <div className="flex items-center gap-1.5 px-0.5">
              <ModelSelector
                settingKey="claude_model"
                currentModel={effectiveSelectedModel}
                onUpdate={(_, model) => setSelectedModel(model)}
                label="Model"
                presets={getModelPresetsForAgent(selectedAgent)}
              />
            </div>
            {/* Controls row */}
            <div className="flex items-center gap-1">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="p-1 text-muted-foreground/40 hover:text-muted-foreground transition-colors rounded hover:bg-muted/50"
                title="Attach file (or drag & drop)"
                type="button"
              >
                <Paperclip className="h-3 w-3" />
              </button>
              <button
                onClick={isRecording ? stopRecording : startRecording}
                disabled={isTranscribing}
                title={isRecording ? "Stop recording" : "Record voice message"}
                type="button"
                className={`flex items-center gap-1 p-1 text-[11px] tabular-nums rounded transition-colors ${
                  isRecording
                    ? "text-red-500 bg-red-500/10"
                    : "text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50"
                }`}
              >
                {isTranscribing ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : isRecording ? (
                  <>
                    <Square className="h-3 w-3 fill-current" />
                    <span className="flex items-center gap-1 pr-0.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
                      {String(Math.floor(recordingSecs / 60)).padStart(1, "0")}:{String(recordingSecs % 60).padStart(2, "0")}
                    </span>
                  </>
                ) : (
                  <Mic className="h-3 w-3" />
                )}
              </button>
              <button
                onClick={() => setFolderBrowserOpen(true)}
                className={`flex items-center gap-1 text-[11px] transition-colors px-1.5 py-0.5 rounded min-w-0 ${
                  folderPath
                    ? "text-violet-500 hover:text-violet-600 hover:bg-violet-500/10"
                    : "text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50"
                }`}
                title={folderPath ? `Project: ${folderPath}` : "Select project folder (optional — auto-detected from prompt)"}
              >
                <FolderOpen className="h-3 w-3 shrink-0" />
                {folderPath && (
                  <span className="truncate max-w-[120px]">{folderPath.split(/[\\/]/).pop()}</span>
                )}
              </button>
              <button
                onClick={skipPerms.toggle}
                className={`p-1 transition-colors rounded ${
                  skipPerms.value
                    ? "text-amber-500 hover:bg-amber-500/10"
                    : "text-muted-foreground/30 hover:text-muted-foreground hover:bg-muted/50"
                }`}
                title={skipPerms.value ? "Skip permissions: ON — click to disable" : "Skip permissions: OFF — click to enable"}
              >
                <ShieldOff className="h-3 w-3" />
              </button>
              <AgentToggleButton
                agent={selectedAgent}
                onCycle={(next) => {
                  setSelectedAgent(next);
                  setSelectedModel(undefined);
                }}
              />
              {compute.nodes.length > 0 && (
                <button
                  onClick={compute.toggle}
                  className={`flex items-center gap-1 text-[11px] transition-colors px-1.5 py-0.5 rounded ${
                    compute.isLocal
                      ? "text-emerald-500 hover:text-emerald-400 hover:bg-emerald-500/10"
                      : "text-sky-500 hover:text-sky-400 hover:bg-sky-500/10"
                  }`}
                  title={compute.isLocal ? "Running locally — click to switch to VM" : `Running on ${compute.currentNode?.name} — click to switch`}
                >
                  {compute.isLocal ? <Monitor className="h-3 w-3" /> : <Cloud className="h-3 w-3" />}
                  <span className="font-medium">
                    {compute.isLocal ? "local" : compute.currentNode?.name ?? "vm"}
                  </span>
                </button>
              )}
              <div className="flex-1" />
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={handleSmartStart}
                disabled={!message.trim() || isBusy}
              >
                {isBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          </div>
        </div>

        {autodetect.suggestions.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {autodetect.suggestions.map((s, i) => {
              const isSelected = folderPath === s.project_path;
              return (
                <button
                  key={s.project_dir}
                  onClick={() => {
                    setFolderPath(s.project_path);
                    autodetect.setAutodetected(true);
                    doStart(s.project_path);
                  }}
                  className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border transition-colors ${
                    isSelected
                      ? "border-violet-500/50 bg-violet-500/10 text-violet-400"
                      : "border-border bg-card text-muted-foreground hover:border-violet-500/30 hover:text-violet-400"
                  }`}
                >
                  <span className="text-[10px] text-muted-foreground/50">{i + 1}</span>
                  <FolderOpen className="h-3 w-3 shrink-0" />
                  <span className="truncate max-w-[120px]">{s.display_name}</span>
                </button>
              );
            })}
            <button
              onClick={() => setFolderBrowserOpen(true)}
              className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-dashed border-border text-muted-foreground/50 hover:border-violet-500/30 hover:text-violet-400 transition-colors"
              title="Choose a different folder"
            >
              <FolderPlus className="h-3 w-3 shrink-0" />
              <span>other...</span>
            </button>
          </div>
        )}

        {autodetect.geminiConfigured === false && autodetect.suggestions.length > 0 && (
          <p className="text-[11px] text-muted-foreground/60 text-center">
            Matched by keywords.{" "}
            <Link href="/claude-sessions/settings" className="text-violet-400 hover:text-violet-300 underline">
              Connect Gemini
            </Link>
            {" "}for smarter detection.
          </p>
        )}

        {session.error && (
          <p className="text-xs text-destructive text-center">{session.error}</p>
        )}

        {recordError && (
          <p className="text-xs text-destructive text-center">{recordError}</p>
        )}

        {session.starting && (
          <div className="flex flex-col items-center gap-1.5 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Starting session...</span>
            </div>
            {session.startTimeout && (
              <p className="text-[11px] text-muted-foreground/70">
                Taking longer than expected. Claude may be waiting for permissions.{" "}
                <button
                  onClick={session.cancel}
                  className="text-violet-400 hover:text-violet-300 underline"
                >
                  Cancel
                </button>
              </p>
            )}
          </div>
        )}
      </div>

      <FolderBrowserDialog
        open={folderBrowserOpen}
        onOpenChange={setFolderBrowserOpen}
        onSelect={(path) => {
          setFolderPath(path);
          autodetect.clearSuggestions();
          setTimeout(() => textareaRef.current?.focus(), 50);
        }}
      />
    </div>
  );
}
