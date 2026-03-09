"use client";

import { useState } from "react";
import { ChevronRight, Folder, FolderOpen, Loader2 } from "lucide-react";
import { QuasarIcon } from "@/components/QuasarIcon";
import { cn } from "@/lib/utils";

interface FolderEntry {
  name: string;
  path: string;
  hasChildren: boolean;
}

interface FolderTreeNodeProps {
  name: string;
  path: string;
  hasChildren: boolean;
  depth: number;
  onLaunch: (path: string) => void;
  onWebStart?: (path: string) => void;
  onSelect?: (path: string) => void;
  launchingPath: string | null;
}

export function FolderTreeNode({
  name,
  path,
  hasChildren,
  depth,
  onLaunch,
  onWebStart,
  onSelect,
  launchingPath,
}: FolderTreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FolderEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    if (!hasChildren) return;

    if (!expanded && children === null) {
      setLoading(true);
      try {
        const res = await fetch(`/api/browse?path=${encodeURIComponent(path)}`);
        const data = await res.json();
        setChildren(data.entries || []);
      } catch {
        setChildren([]);
      } finally {
        setLoading(false);
      }
    }
    setExpanded(!expanded);
  };

  const isLaunching = launchingPath === path;

  return (
    <div>
      <div
        className="group flex items-center gap-1 py-1 px-2 hover:bg-muted/50 rounded cursor-pointer select-none"
        style={{ paddingLeft: depth * 20 + 8 }}
      >
        <button
          onClick={toggle}
          className="flex items-center gap-1 flex-1 min-w-0 text-left"
          disabled={!hasChildren}
        >
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-150",
              expanded && "rotate-90",
              !hasChildren && "invisible"
            )}
          />
          {expanded ? (
            <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="text-xs text-foreground truncate">{name}</span>
        </button>
        {onSelect ? (
          <button
            onClick={() => onSelect(path)}
            className="opacity-0 group-hover:opacity-100 transition-opacity px-1.5 py-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground text-[10px] font-medium whitespace-nowrap"
            title="Select this folder"
          >
            Select
          </button>
        ) : (
          <>
            {onWebStart && (
              <button
                onClick={() => onWebStart(path)}
                disabled={!!launchingPath}
                className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-50"
                title="Start in Quasar"
              >
                <QuasarIcon className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              onClick={() => onLaunch(path)}
              disabled={!!launchingPath}
              className="opacity-0 group-hover:opacity-100 transition-opacity px-1.5 py-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-50 text-[10px] font-medium whitespace-nowrap"
              title="Open in terminal"
            >
              {isLaunching ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                "Terminal"
              )}
            </button>
          </>
        )}
      </div>

      {expanded && (
        <div>
          {loading && (
            <div
              className="flex items-center gap-2 py-1 px-2 text-xs text-muted-foreground"
              style={{ paddingLeft: (depth + 1) * 20 + 8 }}
            >
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading...
            </div>
          )}
          {children && children.length === 0 && !loading && (
            <div
              className="py-1 px-2 text-xs text-muted-foreground/50 italic"
              style={{ paddingLeft: (depth + 1) * 20 + 8 }}
            >
              (empty)
            </div>
          )}
          {children?.map((child) => (
            <FolderTreeNode
              key={child.path}
              name={child.name}
              path={child.path}
              hasChildren={child.hasChildren}
              depth={depth + 1}
              onLaunch={onLaunch}
              onWebStart={onWebStart}
              onSelect={onSelect}
              launchingPath={launchingPath}
            />
          ))}
        </div>
      )}
    </div>
  );
}
