"use client";

import { useState } from "react";
import { ChevronRight, ChevronDown, Brain } from "lucide-react";

interface ThinkingBlockProps {
  content: string;
}

export function ThinkingBlock({ content }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const preview = content.split("\n")[0].slice(0, 100);

  return (
    <div className="border border-border rounded-md overflow-hidden text-xs border-dashed">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted/50 transition-colors text-left"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <Brain className="h-3 w-3 shrink-0 text-purple-500" />
        <span className="font-medium text-purple-500">Thinking</span>
        {!expanded && (
          <span className="text-muted-foreground truncate italic">
            {preview}
          </span>
        )}
      </button>

      {expanded && (
        <div className="border-t border-border border-dashed px-3 py-2 bg-purple-500/5">
          <pre className="font-mono text-[11px] whitespace-pre-wrap break-words max-h-[400px] overflow-y-auto text-muted-foreground leading-relaxed">
            {content}
          </pre>
        </div>
      )}
    </div>
  );
}
