"use client";

import { useState, useRef } from "react";
import { FolderBrowserDialog } from "@/components/FolderBrowserDialog";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { FolderOpen, Send, Loader2, Sparkles, FolderPlus, ShieldOff, Paperclip, Monitor, Cloud, Hammer } from "lucide-react";
import { useAutodetect } from "@/hooks/useAutodetect";
import { useSessionStart } from "@/hooks/useSessionStart";
import { useSettingToggle } from "@/hooks/useSettingToggle";
import { useComputeNode } from "@/hooks/useComputeNode";

export default function SessionsEmptyState() {
  const [message, setMessage] = useState("");
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [folderBrowserOpen, setFolderBrowserOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);

  const skipPerms = useSettingToggle("dangerously_skip_permissions");
  const defaultAgentSetting = useSettingToggle("default_agent");
  const [selectedAgent, setSelectedAgent] = useState<"claude" | "forge">(
    (defaultAgentSetting.value === "forge" ? "forge" : "claude") as "claude" | "forge"
  );
  const compute = useComputeNode();
  const autodetect = useAutodetect();
  const session = useSessionStart();

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

  const handleAutodetect = async () => {
    const firstPath = await autodetect.detect(message);
    if (firstPath) setFolderPath(firstPath);
  };

  const handleStart = () => {
    if (folderPath) session.start(folderPath, message, { agent: selectedAgent });
  };

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
                folderPath ? handleStart() : handleAutodetect();
              }
            }}
            placeholder={`What would you like ${selectedAgent === "forge" ? "Forge" : "Claude"} to do? (⌘Enter to start)`}
            rows={5}
            className="w-full resize-none bg-transparent rounded-lg px-3 py-2.5 pb-10 text-[13px] placeholder:text-muted-foreground/50 focus:outline-none"
            disabled={session.starting}
          />
          <div className="absolute bottom-1.5 left-1.5 right-1.5 flex items-center gap-1.5">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1 text-[11px] text-muted-foreground/50 hover:text-muted-foreground transition-colors px-1.5 py-0.5 rounded hover:bg-muted/50"
              title="Attach file or drag & drop"
              type="button"
            >
              <Paperclip className="h-3 w-3" />
            </button>
            <button
              onClick={() => setFolderBrowserOpen(true)}
              className={`flex items-center gap-1 text-[11px] transition-colors px-1.5 py-0.5 rounded min-w-0 ${
                autodetect.autodetected
                  ? "text-violet-500 hover:text-violet-600 hover:bg-violet-500/10"
                  : "text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50"
              }`}
              title={folderPath || "Select project folder"}
            >
              <FolderOpen className="h-3 w-3 shrink-0" />
              <span className="truncate max-w-[150px]">
                {folderPath ? folderPath.split(/[\\/]/).pop() : "folder..."}
              </span>
            </button>
            <button
              onClick={handleAutodetect}
              disabled={!message.trim() || autodetect.detecting}
              className="flex items-center gap-1 text-[11px] text-muted-foreground/50 hover:text-violet-500 disabled:opacity-30 transition-colors px-1.5 py-0.5 rounded hover:bg-violet-500/10"
              title="Auto-detect project from your prompt"
            >
              {autodetect.detecting ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Sparkles className="h-3 w-3" />
              )}
              <span>auto</span>
            </button>
            <button
              onClick={skipPerms.toggle}
              className={`flex items-center gap-1 text-[11px] transition-colors px-1.5 py-0.5 rounded ${
                skipPerms.value
                  ? "text-amber-500 hover:text-amber-400 hover:bg-amber-500/10"
                  : "text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50"
              }`}
              title={skipPerms.value ? "Skip permissions enabled — click to disable" : "Skip permissions disabled — click to enable"}
            >
              <ShieldOff className="h-3 w-3" />
              <span>skip perms</span>
              <span className={`font-medium ${skipPerms.value ? "text-amber-400" : "text-muted-foreground/60"}`}>
                {skipPerms.value ? "on" : "off"}
              </span>
            </button>
            <button
              onClick={() => setSelectedAgent(a => a === "claude" ? "forge" : "claude")}
              className={`flex items-center gap-1 text-[11px] transition-colors px-1.5 py-0.5 rounded ${
                selectedAgent === "forge"
                  ? "text-orange-400 hover:text-orange-300 hover:bg-orange-500/10"
                  : "text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50"
              }`}
              title={selectedAgent === "forge" ? "Using Forge — click to switch to Claude" : "Using Claude — click to switch to Forge"}
            >
              {selectedAgent === "forge" ? <Hammer className="h-3 w-3" /> : <span className="text-[10px] font-medium">C</span>}
              <span className="font-medium">{selectedAgent}</span>
            </button>
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
              onClick={handleStart}
              disabled={!message.trim() || !folderPath || session.starting}
            >
              {session.starting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
            </Button>
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
                    setTimeout(() => textareaRef.current?.focus(), 50);
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
