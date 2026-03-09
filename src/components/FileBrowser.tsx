"use client";

import { useState, useEffect, useCallback } from "react";
import { ProjectListItem } from "@/lib/types";
import { FileEntry } from "@/app/api/files/route";
import { GDriveAccount } from "@/lib/gdrive";
import { ChevronRight, ChevronDown, Folder, File, Image, FileCode, FileText, Loader2, HardDrive } from "lucide-react";
import { cn } from "@/lib/utils";
import { useRouter } from "next/navigation";
import { FileSearch, FileSearchResult } from "@/components/FileSearch";

// ── Types ────────────────────────────────────────────────────────────────────

interface FileBrowserProps {
  projects: ProjectListItem[];
  gdAccounts?: GDriveAccount[];
}

type GDriveSource = { type: "gdrive"; accountId: string };
type Source = "local" | GDriveSource;

// ── Helpers ──────────────────────────────────────────────────────────────────

const IMG_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
const CODE_EXTS = new Set(["ts", "tsx", "js", "jsx", "py", "go", "rs", "rb", "sh", "json", "yaml", "yml"]);

function getFileIcon(ext: string): React.ReactNode {
  if (IMG_EXTS.has(ext)) return <Image className="h-3.5 w-3.5 text-blue-400/80 shrink-0" />;
  if (CODE_EXTS.has(ext)) return <FileCode className="h-3.5 w-3.5 text-green-400/80 shrink-0" />;
  return <FileText className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />;
}

function isGDriveSource(source: Source): source is GDriveSource {
  return typeof source === "object";
}

// ── Local DirNode ────────────────────────────────────────────────────────────

interface DirNodeProps {
  path: string;
  name: string;
  depth: number;
  onFileClick: (entry: FileEntry) => void;
  selectedPath: string | null;
}

function DirNode({ path: dirPath, name, depth, onFileClick, selectedPath }: DirNodeProps) {
  const [open, setOpen] = useState(depth === 0);
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/files?path=${encodeURIComponent(dirPath)}`);
      const data = await res.json();
      setEntries(data.entries ?? []);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [dirPath]);

  useEffect(() => {
    if (depth === 0) loadEntries();
  }, [depth, loadEntries]);

  const toggle = useCallback(async () => {
    if (!open && entries === null) await loadEntries();
    setOpen((v) => !v);
  }, [open, entries, loadEntries]);

  const indent = depth * 12;

  return (
    <div>
      <button
        onClick={toggle}
        className="w-full flex items-center gap-1.5 px-2 py-1 text-xs hover:bg-accent/50 rounded transition-colors text-left"
        style={{ paddingLeft: `${8 + indent}px` }}
      >
        {open ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/50" /> : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />}
        <Folder className="h-3.5 w-3.5 text-amber-500/80 shrink-0" />
        <span className="truncate font-medium text-foreground/80">{name}</span>
        {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/50 ml-auto" />}
      </button>

      {open && entries && (
        <div>
          {entries.map((entry) =>
            entry.type === "dir" ? (
              <DirNode
                key={entry.path}
                path={entry.path}
                name={entry.name}
                depth={depth + 1}
                onFileClick={onFileClick}
                selectedPath={selectedPath}
              />
            ) : (
              <button
                key={entry.path}
                onClick={() => onFileClick(entry)}
                className={cn(
                  "w-full flex items-center gap-1.5 px-2 py-1 text-xs rounded transition-colors text-left",
                  selectedPath === entry.path ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                )}
                style={{ paddingLeft: `${8 + (depth + 1) * 12}px` }}
              >
                {getFileIcon(entry.ext)}
                <span className="truncate">{entry.name}</span>
              </button>
            )
          )}
          {entries.length === 0 && (
            <div className="text-[10px] text-muted-foreground/40 px-4 py-1" style={{ paddingLeft: `${8 + (depth + 1) * 12}px` }}>
              Empty
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── GDrive DirNode ───────────────────────────────────────────────────────────

interface GDriveDirNodeProps {
  accountId: string;
  folderId: string;
  name: string;
  depth: number;
  onFileClick: (fileId: string, name: string, ext: string) => void;
  selectedId: string | null;
}

function GDriveDirNode({ accountId, folderId, name, depth, onFileClick, selectedId }: GDriveDirNodeProps) {
  const [open, setOpen] = useState(depth === 0);
  const [entries, setEntries] = useState<Array<FileEntry & { driveId: string }> | null>(null);
  const [loading, setLoading] = useState(false);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/gdrive/files?accountId=${accountId}&folderId=${folderId}`);
      const data = await res.json();
      setEntries(data.entries ?? []);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [accountId, folderId]);

  useEffect(() => {
    if (depth === 0) loadEntries();
  }, [depth, loadEntries]);

  const toggle = useCallback(async () => {
    if (!open && entries === null) await loadEntries();
    setOpen((v) => !v);
  }, [open, entries, loadEntries]);

  const indent = depth * 12;

  return (
    <div>
      <button
        onClick={toggle}
        className="w-full flex items-center gap-1.5 px-2 py-1 text-xs hover:bg-accent/50 rounded transition-colors text-left"
        style={{ paddingLeft: `${8 + indent}px` }}
      >
        {open ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/50" /> : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />}
        <Folder className="h-3.5 w-3.5 text-blue-400/80 shrink-0" />
        <span className="truncate font-medium text-foreground/80">{name}</span>
        {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/50 ml-auto" />}
      </button>

      {open && entries && (
        <div>
          {entries.map((entry) =>
            entry.type === "dir" ? (
              <GDriveDirNode
                key={entry.driveId}
                accountId={accountId}
                folderId={entry.driveId}
                name={entry.name}
                depth={depth + 1}
                onFileClick={onFileClick}
                selectedId={selectedId}
              />
            ) : (
              <button
                key={entry.driveId}
                onClick={() => onFileClick(entry.driveId, entry.name, entry.ext)}
                className={cn(
                  "w-full flex items-center gap-1.5 px-2 py-1 text-xs rounded transition-colors text-left",
                  selectedId === entry.driveId ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                )}
                style={{ paddingLeft: `${8 + (depth + 1) * 12}px` }}
              >
                {getFileIcon(entry.ext)}
                <span className="truncate">{entry.name}</span>
              </button>
            )
          )}
          {entries.length === 0 && (
            <div className="text-[10px] text-muted-foreground/40 px-4 py-1" style={{ paddingLeft: `${8 + (depth + 1) * 12}px` }}>
              Empty
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── FileBrowser ──────────────────────────────────────────────────────────────

export function FileBrowser({ projects, gdAccounts = [] }: FileBrowserProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [source, setSource] = useState<Source>("local");
  const [searchActive, setSearchActive] = useState(false);
  const router = useRouter();

  const localRoots = projects.map((p) => p.project_path);

  function handleLocalFileClick(entry: FileEntry): void {
    setSelectedFile(entry.path);
    router.push(`/claude-sessions/files?path=${encodeURIComponent(entry.path)}`);
  }

  function handleGDriveFileClick(fileId: string, _name: string, _ext: string): void {
    if (!isGDriveSource(source)) return;
    setSelectedFile(fileId);
    router.push(`/claude-sessions/files?fileId=${encodeURIComponent(fileId)}&source=gdrive&accountId=${source.accountId}`);
  }

  function handleSearchSelect(result: FileSearchResult): void {
    setSelectedFile(result.path);
    router.push(`/claude-sessions/files?path=${encodeURIComponent(result.path)}`);
  }

  function renderGDriveTree(): React.ReactNode {
    if (!isGDriveSource(source)) return null;
    const account = gdAccounts.find((a) => a.id === source.accountId);
    return (
      <GDriveDirNode
        accountId={source.accountId}
        folderId="root"
        name={account?.name ?? "Drive"}
        depth={0}
        onFileClick={handleGDriveFileClick}
        selectedId={selectedFile}
      />
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      {gdAccounts.length > 0 && (
        <div className="px-2 pt-1.5 pb-1 flex gap-1 flex-wrap shrink-0">
          <button
            onClick={() => setSource("local")}
            className={cn(
              "flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition-colors",
              source === "local"
                ? "bg-accent text-accent-foreground font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
            )}
          >
            <HardDrive className="h-2.5 w-2.5" />
            Local
          </button>
          {gdAccounts.map((acc) => (
            <button
              key={acc.id}
              onClick={() => setSource({ type: "gdrive", accountId: acc.id })}
              className={cn(
                "flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition-colors",
                isGDriveSource(source) && source.accountId === acc.id
                  ? "bg-accent text-accent-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
              )}
            >
              <File className="h-2.5 w-2.5" />
              {acc.name}
            </button>
          ))}
        </div>
      )}

      {source === "local" && localRoots.length > 0 && (
        <div className="px-2 pb-1.5 shrink-0">
          <FileSearch
            roots={localRoots}
            onSelect={handleSearchSelect}
            onClear={() => setSearchActive(false)}
            hasResults={searchActive}
          />
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {source === "local" ? (
          projects.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground/50 p-4 text-center">
              No projects — scan sessions first
            </div>
          ) : (
            projects.map((project) => (
              <DirNode
                key={project.project_dir}
                path={project.project_path}
                name={project.display_name}
                depth={0}
                onFileClick={handleLocalFileClick}
                selectedPath={selectedFile}
              />
            ))
          )
        ) : (
          renderGDriveTree()
        )}
      </div>
    </div>
  );
}
