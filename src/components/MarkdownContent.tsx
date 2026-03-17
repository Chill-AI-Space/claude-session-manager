"use client";

import { memo, useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { FolderOpen, Check, Maximize2, X, ChevronUp } from "lucide-react";

interface MarkdownContentProps {
  content: string;
  projectPath?: string;
  /** Smaller font sizes for full-page views like MD session view */
  compact?: boolean;
}

// Detect file/directory path strings that are worth making clickable.
const FILE_PATH_RE =
  /^(~\/[^\s]+|\/[^\s]+|\.{1,2}\/[^\s]+|(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+(?:\.[a-zA-Z0-9]+)?)$/;

function isFilePath(text: string): boolean {
  const t = text.trim();
  if (!t || t.includes(" ") || t.startsWith("http")) return false;
  return FILE_PATH_RE.test(t);
}

function FileLink({ filePath, projectPath }: { filePath: string; projectPath?: string }) {
  const [done, setDone] = useState(false);

  async function reveal() {
    try {
      await fetch("/api/open-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath, cwd: projectPath, action: "reveal" }),
      });
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch { /* ignore */ }
  }

  return (
    <span className="inline-flex items-center gap-0.5 group">
      <code className="bg-muted px-1.5 py-0.5 rounded text-[13px] font-mono">
        {filePath}
      </code>
      <button
        onClick={reveal}
        className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground/60 hover:text-foreground ml-0.5 align-middle"
        title="Reveal in Finder"
      >
        {done
          ? <Check className="inline h-3 w-3 text-green-500" />
          : <FolderOpen className="inline h-3 w-3" />
        }
      </button>
    </span>
  );
}

function TableWrapper({ children }: { children: React.ReactNode }) {
  const [focused, setFocused] = useState(false);

  if (focused) {
    return (
      <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm flex flex-col items-center justify-center p-8">
        <div className="w-full max-w-[95vw] max-h-[90vh] overflow-auto rounded-xl border border-border shadow-2xl bg-card">
          <table className="w-full text-[14px] border-collapse">
            {children}
          </table>
        </div>
        <button
          onClick={() => setFocused(false)}
          className="absolute top-4 right-4 p-2 rounded-lg bg-muted hover:bg-muted/80 text-foreground transition-colors"
          title="Exit focus mode"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
    );
  }

  return (
    <div className="not-prose overflow-x-auto my-3 rounded-lg border border-border/50 relative group/table">
      <button
        onClick={() => setFocused(true)}
        className="absolute top-1.5 right-1.5 p-1 rounded bg-muted/80 hover:bg-muted text-muted-foreground/60 hover:text-foreground opacity-0 group-hover/table:opacity-100 transition-opacity z-10"
        title="Focus mode"
      >
        <Maximize2 className="h-3.5 w-3.5" />
      </button>
      <table className="text-[13px] border-collapse">{children}</table>
    </div>
  );
}

/** Split markdown into sections by message headers (### User #N / ### Claude #N). */
function splitSections(content: string): string[] {
  const lines = content.split("\n");
  const sections: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (/^### (?:User|Claude) #\d+/.test(line) && current.length > 0) {
      sections.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) sections.push(current.join("\n"));
  return sections;
}

/** Number of sections rendered immediately from the end (plus header) */
const INITIAL_VISIBLE = 15;

function MarkdownRenderer({ content, projectPath, compact }: MarkdownContentProps) {
  const textSize = compact ? "prose-xs" : "prose-base";
  const codeSize = compact ? "text-[11px]" : "text-[12.5px]";
  const inlineCodeSize = compact ? "text-[11px]" : "text-[13px]";

  return (
    <div className={`markdown-body prose ${textSize} dark:prose-invert max-w-none prose-p:my-2 prose-headings:my-3 prose-headings:first:mt-0 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-pre:my-3 prose-code:before:content-none prose-code:after:content-none prose-hr:my-4 prose-blockquote:my-2 prose-blockquote:pl-4 prose-blockquote:border-l-2 prose-blockquote:border-muted-foreground/30 prose-table:my-3`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw]}
        components={{
          code({ className, children, ...props }) {
            const isInline = !className;
            if (isInline) {
              const text = typeof children === "string" ? children : String(children ?? "");
              if (isFilePath(text)) {
                return <FileLink filePath={text} projectPath={projectPath} />;
              }
              return (
                <code
                  className={`bg-muted px-1.5 py-0.5 rounded ${inlineCodeSize} font-mono`}
                  {...props}
                >
                  {children}
                </code>
              );
            }
            const language = className?.replace("language-", "") || "";
            return (
              <div className="relative group not-prose">
                {language && (
                  <div className="absolute top-0 right-0 px-2 py-0.5 text-[10px] text-muted-foreground/50 bg-muted rounded-bl font-mono">
                    {language}
                  </div>
                )}
                <pre className="bg-muted/40 border border-border/40 rounded-lg p-4 overflow-x-auto">
                  <code className={`${codeSize} leading-relaxed font-mono`} {...props}>
                    {children}
                  </code>
                </pre>
              </div>
            );
          },
          a({ href, children }) {
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">
                {children}
              </a>
            );
          },
          table({ children }) { return <TableWrapper>{children}</TableWrapper>; },
          thead({ children }) { return <thead className="bg-muted/60 dark:bg-muted/30">{children}</thead>; },
          th({ children }) { return <th className="px-3 py-2.5 text-left text-[12px] font-semibold text-foreground/80 border-b border-border/50 whitespace-nowrap">{children}</th>; },
          td({ children }) { return <td className="px-3 py-2 text-[13px] border-b border-border/20 text-foreground/90">{children}</td>; },
          tr({ children }) { return <tr className="even:bg-muted/15 hover:bg-muted/30 transition-colors">{children}</tr>; },
          h1({ children }) { return <h1 className="text-xl font-bold mt-5 mb-3 first:mt-0">{children}</h1>; },
          h2({ children }) { return <h2 className="text-lg font-semibold mt-4 mb-2 first:mt-0">{children}</h2>; },
          h3({ children }) { return <h3 className="text-[15px] font-semibold mt-3 mb-1.5 first:mt-0">{children}</h3>; },
          ul({ children }) { return <ul className="my-2 pl-5 space-y-1 list-disc marker:text-muted-foreground/50">{children}</ul>; },
          ol({ children }) { return <ol className="my-2 pl-5 space-y-1 list-decimal marker:text-muted-foreground/60">{children}</ol>; },
          li({ children }) { return <li className="pl-1">{children}</li>; },
          blockquote({ children }) { return <blockquote className="my-2 pl-4 border-l-2 border-muted-foreground/30 text-muted-foreground italic">{children}</blockquote>; },
          hr() { return <hr className="my-4 border-border/50" />; },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export const MarkdownContent = memo(function MarkdownContent({
  content,
  projectPath,
  compact,
}: MarkdownContentProps) {
  if (!content.trim()) return null;

  const sections = useMemo(() => splitSections(content), [content]);
  const [showAll, setShowAll] = useState(false);

  // Small content — render everything
  if (sections.length <= INITIAL_VISIBLE) {
    return <MarkdownRenderer content={content} projectPath={projectPath} compact={compact} />;
  }

  // Large content — show header + last INITIAL_VISIBLE sections, button to expand
  const hiddenCount = sections.length - INITIAL_VISIBLE;
  const header = sections[0]; // Session metadata
  const visibleSections = showAll
    ? sections
    : [header, ...sections.slice(sections.length - INITIAL_VISIBLE + 1)];

  return (
    <div>
      {!showAll && (
        <div className="flex items-center justify-center py-2 mb-3 border-b border-dashed border-muted-foreground/20">
          <button
            onClick={() => setShowAll(true)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
          >
            <ChevronUp className="h-3 w-3" />
            Show {hiddenCount} earlier messages
          </button>
        </div>
      )}
      <MarkdownRenderer
        content={visibleSections.join("\n")}
        projectPath={projectPath}
        compact={compact}
      />
    </div>
  );
});
