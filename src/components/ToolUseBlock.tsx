"use client";

import { useState } from "react";
import { ChevronRight, ChevronDown, Wrench, Check, Copy, FolderOpen } from "lucide-react";

interface ToolUseBlockProps {
  name: string;
  input: Record<string, unknown>;
  result?: string;
}

function getToolLabel(name: string): string {
  const labels: Record<string, string> = {
    Read: "Read File",
    Write: "Write File",
    Edit: "Edit File",
    Bash: "Terminal",
    Glob: "Find Files",
    Grep: "Search",
    Agent: "Sub-agent",
    WebFetch: "Fetch URL",
    WebSearch: "Web Search",
    AskUserQuestion: "Ask User",
    EnterPlanMode: "Plan Mode",
    ExitPlanMode: "Exit Plan",
    NotebookEdit: "Notebook Edit",
  };
  return labels[name] || name;
}

function getToolSummary(
  name: string,
  input: Record<string, unknown>
): string {
  switch (name) {
    case "Read":
      return (input.file_path as string) || "";
    case "Write":
      return (input.file_path as string) || "";
    case "Edit":
      return (input.file_path as string) || "";
    case "Bash":
      return (input.command as string)?.slice(0, 100) || "";
    case "Glob":
      return (input.pattern as string) || "";
    case "Grep":
      return (input.pattern as string) || "";
    case "Agent":
      return (input.description as string) || "";
    case "WebFetch":
      return (input.url as string) || "";
    case "WebSearch":
      return (input.query as string) || "";
    default:
      return "";
  }
}

const PATH_TOOLS = new Set(["Read", "Write", "Edit"]);

function CopyablePath({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);

  function handleReveal(e: React.MouseEvent) {
    e.stopPropagation();
    fetch("/api/open-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: text, action: "reveal" }),
    });
    setRevealed(true);
    setTimeout(() => setRevealed(false), 1500);
  }

  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <span className="text-muted-foreground truncate font-mono inline-flex items-center gap-1">
      <span
        className="truncate cursor-pointer hover:text-foreground hover:underline underline-offset-2 transition-colors"
        title="Open in Finder"
        onClick={handleReveal}
      >
        {text}
      </span>
      {revealed ? (
        <FolderOpen className="h-2.5 w-2.5 shrink-0 text-green-500" />
      ) : copied ? (
        <Check className="h-2.5 w-2.5 shrink-0 text-green-500" />
      ) : (
        <button
          onClick={handleCopy}
          title="Copy path"
          className="opacity-0 group-hover/tool:opacity-60 hover:!opacity-100 transition-opacity"
        >
          <Copy className="h-2.5 w-2.5 shrink-0" />
        </button>
      )}
    </span>
  );
}

export function ToolUseBlock({ name, input, result }: ToolUseBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const summary = getToolSummary(name, input);
  const isCopyable = PATH_TOOLS.has(name) && summary;

  return (
    <div className="group/tool border border-border rounded-md overflow-hidden text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted/50 transition-colors text-left"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <Wrench className="h-3 w-3 shrink-0 text-blue-500" />
        <span className="font-medium text-blue-500">
          {getToolLabel(name)}
        </span>
        {summary && (isCopyable ? (
          <CopyablePath text={summary} />
        ) : (
          <span className="text-muted-foreground truncate font-mono">
            {summary}
          </span>
        ))}
      </button>

      {expanded && (
        <div className="border-t border-border">
          <div className="px-3 py-2 bg-muted/30">
            <div className="text-[10px] font-medium text-muted-foreground mb-1">
              Input
            </div>
            <pre className="font-mono text-[11px] whitespace-pre-wrap break-all max-h-[300px] overflow-y-auto">
              {JSON.stringify(input, null, 2)}
            </pre>
          </div>
          {result && (
            <div className="px-3 py-2 border-t border-border bg-muted/20">
              <div className="text-[10px] font-medium text-muted-foreground mb-1">
                Result
              </div>
              <pre className="font-mono text-[11px] whitespace-pre-wrap break-all max-h-[300px] overflow-y-auto text-muted-foreground">
                {result.slice(0, 3000)}
                {result.length > 3000 && "\n... (truncated)"}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
