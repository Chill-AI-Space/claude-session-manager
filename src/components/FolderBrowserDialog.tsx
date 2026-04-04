"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FolderTreeNode } from "@/components/FolderTreeNode";
import { Loader2, CheckCircle2, AlertCircle, Search, FolderOpen, Send, ChevronUp, FolderPlus } from "lucide-react";
import { QuasarIcon } from "@/components/QuasarIcon";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ModelSelector, MODEL_PRESETS } from "@/components/settings/ModelSelector";
import { useSettings } from "@/lib/settings";

interface FolderEntry {
  name: string;
  path: string;
  hasChildren: boolean;
}

interface FolderBrowserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect?: (path: string) => void;
}

export function FolderBrowserDialog({
  open,
  onOpenChange,
  onSelect,
}: FolderBrowserDialogProps) {
  const router = useRouter();
  const [entries, setEntries] = useState<FolderEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [launchingPath, setLaunchingPath] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<FolderEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [homeDir, setHomeDir] = useState("");
  const [currentPath, setCurrentPath] = useState("");
  const [parentPath, setParentPath] = useState<string | null>(null);

  // Create folder
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const newFolderRef = useRef<HTMLInputElement>(null);

  // Web start mode
  const [webStartPath, setWebStartPath] = useState<string | null>(null);
  const [webMessage, setWebMessage] = useState("");
  const [webStarting, setWebStarting] = useState(false);
  const webInputRef = useRef<HTMLTextAreaElement>(null);
  const { settings, updateSetting } = useSettings();
  const [webModel, setWebModel] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (open) {
      setLoading(true);
      setSuccess(null);
      setError(null);
      setSearchQuery("");
      setSearchResults([]);
      setWebStartPath(null);
      setWebMessage("");
      setCreatingFolder(false);
      setNewFolderName("");
      // For web start, default to Forge's default model (Gemini 3 Flash Preview)
      setWebModel(
        settings.claude_model === "claude-sonnet-4-6"
          ? "models/gemini-3-flash-preview"
          : settings.claude_model,
      );
      fetch("/api/browse")
        .then((res) => res.json())
        .then((data) => {
          setEntries(data.entries || []);
          if (data.homeDir) setHomeDir(data.homeDir);
          if (data.currentPath) setCurrentPath(data.currentPath);
          setParentPath(data.parentPath || null);
        })
        .catch(() => {
          setEntries([]);
          setError("Failed to load directories");
        })
        .finally(() => {
          setLoading(false);
          // Auto-focus search on open
          setTimeout(() => inputRef.current?.focus(), 50);
        });
    }
  }, [open]);

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    searchTimerRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/browse?q=${encodeURIComponent(searchQuery)}`);
        const data = await res.json();
        setSearchResults(data.entries || []);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 200);
  }, [searchQuery]);

  const navigateTo = async (targetPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/browse?path=${encodeURIComponent(targetPath)}`);
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setEntries(data.entries || []);
        setCurrentPath(data.currentPath || targetPath);
        setParentPath(data.parentPath || null);
      }
    } catch {
      setError("Failed to load directory");
    } finally {
      setLoading(false);
    }
  };

  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    try {
      const res = await fetch("/api/browse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentPath: currentPath, name }),
      });
      const data = await res.json();
      if (data.ok) {
        setCreatingFolder(false);
        setNewFolderName("");
        // Refresh current directory
        navigateTo(currentPath);
      } else {
        setError(data.error || "Failed to create folder");
      }
    } catch {
      setError("Failed to create folder");
    }
  };

  const handleLaunch = async (path: string) => {
    setLaunchingPath(path);
    setError(null);
    try {
      const res = await fetch("/api/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const data = await res.json();
      if (data.ok) {
        setSuccess(data.terminal);
        setTimeout(() => {
          onOpenChange(false);
          setSuccess(null);
        }, 1500);
      } else {
        setError(data.error || "Failed to open terminal");
      }
    } catch {
      setError("Failed to open terminal");
    } finally {
      setLaunchingPath(null);
    }
  };

  const handleWebStart = (path: string) => {
    setWebStartPath(path);
    setWebMessage("");
    setTimeout(() => webInputRef.current?.focus(), 50);
  };

  const handleSelect = (path: string) => {
    onSelect?.(path);
    onOpenChange(false);
  };

  const submitWebStart = async () => {
    if (!webStartPath || !webMessage.trim()) return;
    setWebStarting(true);
    setError(null);

    try {
      const res = await fetch("/api/sessions/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: webStartPath,
          message: webMessage.trim(),
          agent: "forge",
          model: webModel,
        }),
      });

      if (!res.ok) throw new Error("Failed to start session");

      // Don't wait for Claude to fully start — show success and close
      setSuccess("launching");
      setTimeout(() => {
        onOpenChange(false);
        setSuccess(null);
      }, 2000);

      // Keep reading stream in background to not abort the process
      // but don't block the UI
      if (res.body) {
        const reader = res.body.getReader();
        (async () => {
          try {
            while (true) {
              const { done } = await reader.read();
              if (done) break;
            }
          } catch { /* stream closed */ }
        })();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start session");
      setWebStarting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg flex flex-col" style={{ maxHeight: "min(80vh, 600px)" }}>
        <DialogHeader className="shrink-0">
          <DialogTitle className="text-sm">{onSelect ? "Select folder" : "Start new session"}</DialogTitle>
        </DialogHeader>

        {success ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            {success === "launching" ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
                <span>Session is starting...</span>
                <span className="text-xs text-muted-foreground/70">Claude needs a moment to launch. The session will appear in the list.</span>
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                Opened in {success}
              </>
            )}
          </div>
        ) : (
          <>
            {/* Search input */}
            <div className="relative shrink-0">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                ref={inputRef}
                placeholder="Filter folders..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-8 pl-8 text-sm"
              />
              {searching && (
                <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-muted-foreground" />
              )}
            </div>

            {/* Navigation bar */}
            {!searchQuery.trim() && currentPath && (
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => parentPath && navigateTo(parentPath)}
                  disabled={!parentPath || loading}
                  className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
                  title="Go up"
                >
                  <ChevronUp className="h-4 w-4" />
                </button>
                <span className="text-xs text-muted-foreground truncate flex-1 select-none">
                  {homeDir ? currentPath.replace(homeDir, "~") : currentPath}
                </span>
                <button
                  onClick={() => { setCreatingFolder(true); setTimeout(() => newFolderRef.current?.focus(), 50); }}
                  className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                  title="New folder"
                >
                  <FolderPlus className="h-4 w-4" />
                </button>
              </div>
            )}

            {/* Create folder input */}
            {creatingFolder && (
              <div className="flex items-center gap-1.5 shrink-0">
                <FolderPlus className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <Input
                  ref={newFolderRef}
                  placeholder="New folder name..."
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") createFolder();
                    if (e.key === "Escape") { setCreatingFolder(false); setNewFolderName(""); }
                  }}
                  className="h-7 text-xs flex-1"
                />
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={createFolder} disabled={!newFolderName.trim()}>
                  Create
                </Button>
                <Button size="sm" variant="ghost" className="h-7 px-1.5 text-xs text-muted-foreground" onClick={() => { setCreatingFolder(false); setNewFolderName(""); }}>
                  ✕
                </Button>
              </div>
            )}

            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="flex-1 min-h-0 -mx-6 overflow-y-auto px-6">
                {error && (
                  <div className="flex items-center gap-2 px-3 py-2 mb-2 rounded bg-destructive/10 text-destructive text-xs">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    {error}
                  </div>
                )}

                {searchQuery.trim() ? (
                  // Search results — flat list
                  <div className="py-1">
                    {searchResults.length === 0 && !searching ? (
                      <div className="text-xs text-muted-foreground text-center py-4">
                        No folders match &quot;{searchQuery}&quot;
                      </div>
                    ) : (
                      searchResults.map((entry) => (
                        <div
                          key={entry.path}
                          className="group flex items-center gap-2 w-full px-3 py-2 rounded text-sm hover:bg-accent transition-colors"
                        >
                          <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
                          <span className="flex-1 min-w-0">
                            <span className="font-medium">{entry.name}</span>
                            <span className="block text-xs text-muted-foreground truncate">
                              {homeDir ? entry.path.replace(homeDir, "~") : entry.path}
                            </span>
                          </span>
                          {onSelect ? (
                            <button
                              onClick={() => handleSelect(entry.path)}
                              className="opacity-0 group-hover:opacity-100 transition-opacity px-1.5 py-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground text-[10px] font-medium whitespace-nowrap"
                              title="Select this folder"
                            >
                              Select
                            </button>
                          ) : (
                            <>
                              <button
                                onClick={() => handleWebStart(entry.path)}
                                disabled={!!launchingPath}
                                className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-50"
                                title="Start in Quasar"
                              >
                                <QuasarIcon className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => handleLaunch(entry.path)}
                                disabled={!!launchingPath}
                                className="opacity-0 group-hover:opacity-100 transition-opacity px-1.5 py-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-50 text-[10px] font-medium whitespace-nowrap"
                                title="Open in terminal"
                              >
                                {launchingPath === entry.path ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  "Terminal"
                                )}
                              </button>
                            </>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                ) : (
                  // Normal tree view
                  <div className="py-1">
                    {entries.map((entry) => (
                      <FolderTreeNode
                        key={entry.path}
                        name={entry.name}
                        path={entry.path}
                        hasChildren={entry.hasChildren}
                        depth={0}
                        onLaunch={handleLaunch}
                        onWebStart={onSelect ? undefined : handleWebStart}
                        onSelect={onSelect ? handleSelect : undefined}
                        launchingPath={launchingPath}
                      />
                    ))}
                    {entries.length === 0 && !error && (
                      <div className="text-xs text-muted-foreground text-center py-4">
                        No directories found
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Web start panel */}
            {webStartPath && (
              <div className="shrink-0 border-t border-border pt-3 space-y-2">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <QuasarIcon className="h-3.5 w-3.5" />
                  <span className="font-medium text-foreground truncate">
                    {homeDir ? webStartPath.replace(homeDir, "~") : webStartPath}
                  </span>
                  <button
                    onClick={() => setWebStartPath(null)}
                    className="ml-auto text-muted-foreground/50 hover:text-foreground"
                  >✕</button>
                </div>
                <div className="flex flex-col gap-2">
                  <ModelSelector
                    settingKey="claude_model" // Re-using claude_model for Forge selection
                    currentModel={webModel || ""}
                    onUpdate={(_, model) => setWebModel(model)}
                    label="Forge Model"
                  />
                  <div className="flex gap-2 items-end">
                    <textarea
                      ref={webInputRef}
                      value={webMessage}
                      onChange={(e) => setWebMessage(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          submitWebStart();
                        }
                      }}
                      placeholder="First message to Forge..."
                      rows={2}
                      className="flex-1 resize-none bg-muted/30 border border-input rounded px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
                      disabled={webStarting}
                    />
                    <Button
                      size="icon"
                      className="h-9 w-9 shrink-0"
                      onClick={submitWebStart}
                      disabled={!webMessage.trim() || webStarting}
                    >
                      {webStarting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
