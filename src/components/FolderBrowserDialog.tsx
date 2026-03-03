"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FolderTreeNode } from "@/components/FolderTreeNode";
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";

interface FolderEntry {
  name: string;
  path: string;
  hasChildren: boolean;
}

interface FolderBrowserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function FolderBrowserDialog({
  open,
  onOpenChange,
}: FolderBrowserDialogProps) {
  const [entries, setEntries] = useState<FolderEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [launchingPath, setLaunchingPath] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setLoading(true);
      setSuccess(null);
      setError(null);
      fetch("/api/browse")
        .then((res) => res.json())
        .then((data) => setEntries(data.entries || []))
        .catch(() => {
          setEntries([]);
          setError("Failed to load directories");
        })
        .finally(() => setLoading(false));
    }
  }, [open]);

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg flex flex-col" style={{ maxHeight: "min(80vh, 600px)" }}>
        <DialogHeader className="shrink-0">
          <DialogTitle className="text-sm">Start new session</DialogTitle>
        </DialogHeader>

        {success ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            Opened in {success}
          </div>
        ) : loading ? (
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
            <div className="py-1">
              {entries.map((entry) => (
                <FolderTreeNode
                  key={entry.path}
                  name={entry.name}
                  path={entry.path}
                  hasChildren={entry.hasChildren}
                  depth={0}
                  onLaunch={handleLaunch}
                  launchingPath={launchingPath}
                />
              ))}
              {entries.length === 0 && !error && (
                <div className="text-xs text-muted-foreground text-center py-4">
                  No directories found
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
