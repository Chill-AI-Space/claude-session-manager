"use client";

import { memo, useState, useMemo, useCallback, useEffect, useRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { FolderOpen, Check, Maximize2, X, Copy } from "lucide-react";

interface MarkdownContentProps {
  content: string;
  projectPath?: string;
  /** Smaller font sizes for full-page views like MD session view */
  compact?: boolean;
  /** Collapse messages: user shows first few lines, claude shows header + preview */
  folded?: boolean;
  /** Search query — auto-expands all sections and scrolls to + highlights first match */
  highlightQuery?: string;
}

/** Extract plain text from React children (for detecting User/Claude in h3) */
function extractText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (typeof node === 'object' && 'props' in node) {
    return extractText((node as React.ReactElement<{ children?: React.ReactNode }>).props?.children);
  }
  return '';
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

function CopyButton({ getText, className = "" }: { getText: () => string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(getText());
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className={`p-1 rounded text-muted-foreground/40 hover:text-muted-foreground transition-all ${className}`}
      title="Copy"
    >
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
    </button>
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
    <div className="not-prose overflow-x-auto my-3 rounded-lg border border-border/50 relative group/table" ref={(el) => { if (el) (el as HTMLDivElement & { _tableRef: HTMLDivElement })._tableRef = el; }}>
      <div className="absolute top-1.5 right-1.5 flex gap-0.5 opacity-0 group-hover/table:opacity-100 transition-opacity z-10">
        <CopyButton
          getText={() => {
            const table = document.querySelector('.group\\/table:hover table') as HTMLElement | null;
            return table?.innerText || '';
          }}
          className="bg-muted/80 hover:bg-muted"
        />
        <button
          onClick={() => setFocused(true)}
          className="p-1 rounded bg-muted/80 hover:bg-muted text-muted-foreground/60 hover:text-foreground transition-opacity"
          title="Focus mode"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <table className="text-[13px] border-collapse">{children}</table>
    </div>
  );
}

/** Split markdown into sections by message headers (### User #N / ### Claude #N).
 *  Returns array of { key, content } for stable React reconciliation. */
interface Section {
  key: string;
  content: string;
}

function splitSections(content: string): Section[] {
  const lines = content.split("\n");
  const sections: Section[] = [];
  let current: string[] = [];
  let currentKey = "header";

  for (const line of lines) {
    const match = line.match(/^### (User|Claude) #(\d+)/);
    if (match && current.length > 0) {
      sections.push({ key: currentKey, content: current.join("\n") });
      current = [];
      currentKey = `${match[1].toLowerCase()}-${match[2]}`;
    }
    current.push(line);
  }
  if (current.length > 0) sections.push({ key: currentKey, content: current.join("\n") });
  return sections;
}

/** Number of sections rendered immediately from the end (plus header) */

/** Build the shared ReactMarkdown components config (stable reference via useMemo). */
function useMarkdownComponents(projectPath?: string, compact?: boolean): Components {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useMemo((): Components => {
    const codeSize = compact ? "text-[10.5px]" : "text-[12.5px]";
    const inlineCodeSize = compact ? "text-[11px]" : "text-[13px]";
    return {
      code({ className, children, ...props }) {
        const isInline = !className;
        if (isInline) {
          const text = typeof children === "string" ? children : String(children ?? "");
          if (isFilePath(text)) {
            return <FileLink filePath={text} projectPath={projectPath} />;
          }
          return (
            <code className={`bg-muted px-1.5 py-0.5 rounded ${inlineCodeSize} font-mono`} {...props}>
              {children}
            </code>
          );
        }
        const language = className?.replace("language-", "") || "";
        const codeText = typeof children === "string" ? children : String(children ?? "");
        return (
          <div className="relative group/code not-prose">
            <div className="absolute top-0 right-0 flex items-center gap-0.5 opacity-0 group-hover/code:opacity-100 transition-opacity z-10">
              <CopyButton getText={() => codeText.replace(/\n$/, "")} className="bg-muted/80 hover:bg-muted" />
              {language && (
                <span className="px-2 py-0.5 text-[10px] text-muted-foreground/50 bg-muted rounded-bl font-mono">
                  {language}
                </span>
              )}
            </div>
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
      h1({ children }) { return <h1 className={`font-bold first:mt-0 ${compact ? "text-[15px] mt-5 mb-2" : "text-xl mt-5 mb-3"}`}>{children}</h1>; },
      h2({ children }) { return <h2 className={`font-semibold first:mt-0 ${compact ? "text-[13.5px] mt-4 mb-1.5" : "text-lg mt-4 mb-2"}`}>{children}</h2>; },
      h3({ children }) {
        const text = extractText(children);
        let color = '';
        if (/^User\s+#\d/.test(text)) color = 'text-blue-600/80 dark:text-blue-400/80';
        else if (/^Claude\s+#\d/.test(text)) color = 'text-amber-600/60 dark:text-amber-400/60';
        return <h3 className={`font-semibold first:mt-0 ${compact ? "text-[12.5px] mt-3 mb-1" : "text-[15px] mt-3 mb-1.5"} ${color}`}>{children}</h3>;
      },
      ul({ children }) { return <ul className="my-2 pl-5 space-y-1 list-disc marker:text-muted-foreground/50">{children}</ul>; },
      ol({ children }) { return <ol className="my-2 pl-5 space-y-1 list-decimal marker:text-muted-foreground/60">{children}</ol>; },
      li({ children }) { return <li className="pl-1">{children}</li>; },
      blockquote({ children }) { return <blockquote className="my-2 pl-4 border-l-2 border-muted-foreground/30 text-muted-foreground italic">{children}</blockquote>; },
      hr() { return <hr className="my-4 border-border/50" />; },
    };
  }, [projectPath, compact]);
}

/** Single section rendered as memoized markdown. Skips re-render when content is unchanged. */
const MemoSection = memo(function MemoSection({
  content,
  components,
  className,
}: {
  content: string;
  projectPath?: string;
  compact?: boolean;
  components: Components;
  className: string;
}) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

/** Render full markdown as a single block (used for non-session content like summaries). */
function MarkdownRenderer({ content, projectPath, compact }: MarkdownContentProps) {
  const compactClasses = compact ? [
    "text-[12px] leading-[1.7]",
    "prose-p:my-1.5 prose-p:text-[12px] prose-p:leading-[1.65]",
    "prose-h1:text-[15px] prose-h1:mt-5 prose-h1:mb-2",
    "prose-h2:text-[13.5px] prose-h2:mt-4 prose-h2:mb-1.5",
    "prose-h3:text-[12.5px] prose-h3:mt-3 prose-h3:mb-1",
    "prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-li:text-[12px]",
    "prose-td:text-[11px] prose-th:text-[10.5px] prose-table:my-2",
    "prose-pre:my-2",
    "prose-blockquote:my-2 prose-hr:my-3",
  ].join(" ") : "";

  const components = useMarkdownComponents(projectPath, compact);
  const className = `markdown-body prose prose-sm dark:prose-invert max-w-none prose-code:before:content-none prose-code:after:content-none prose-headings:first:mt-0 prose-blockquote:pl-3 prose-blockquote:border-l-2 prose-blockquote:border-muted-foreground/30 ${compactClasses}`;

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/** Truncate a section's markdown for folded display */
function truncateForFold(section: Section): string {
  const lines = section.content.split('\n');
  const header = lines[0];

  if (section.key.startsWith('user-')) {
    // User: header + first 3 meaningful body lines
    const body = lines.slice(1);
    const out: string[] = [header, ''];
    let count = 0;
    for (const line of body) {
      if (count >= 3) break;
      out.push(line);
      if (line.trim()) count++;
    }
    if (body.filter(l => l.trim()).length > 3) out.push('', '*…*');
    return out.join('\n');
  }

  // Claude: header + first text line as preview
  const body = lines.slice(1);
  for (const line of body) {
    const t = line.trim();
    if (!t || t.startsWith('**🔧') || t.startsWith('<details') || t.startsWith('*empty') || t.startsWith('---') || t.startsWith('💭')) continue;
    const clean = t.replace(/[*_`#]/g, '').slice(0, 100);
    if (clean) return header + '\n\n' + `*${clean}…*`;
  }
  // Fallback: tool names
  const tools = body.map(l => l.match(/\*\*🔧 (\w+)\*\*/)?.[1]).filter(Boolean);
  if (tools.length > 0) return header + '\n\n' + `*${tools.join(' → ')}*`;
  return header;
}

/** Section that can be expanded/collapsed in folded mode */
function FoldableSection({
  section,
  components,
  className,
}: {
  section: Section;
  components: Components;
  className: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const isUser = section.key.startsWith('user-');
  const isClaude = section.key.startsWith('claude-');

  // Non-message sections (header, hr, etc.) render normally
  if (!isUser && !isClaude) {
    return <MemoSection content={section.content} components={components} className={className} />;
  }

  if (expanded) {
    return (
      <div className="cursor-pointer" onClick={() => setExpanded(false)} title="Click to collapse">
        <MemoSection content={section.content} components={components} className={className} />
      </div>
    );
  }

  // Collapsed
  const truncated = truncateForFold(section);
  return (
    <div
      className={`cursor-pointer ${isClaude ? 'opacity-50 hover:opacity-80' : 'hover:opacity-80'} transition-opacity`}
      onClick={() => setExpanded(true)}
      title="Click to expand"
    >
      <MemoSection content={truncated} components={components} className={className} />
    </div>
  );
}

export const MarkdownContent = memo(function MarkdownContent({
  content,
  projectPath,
  compact,
  folded,
  highlightQuery,
}: MarkdownContentProps) {
  if (!content.trim()) return null;

  const containerRef = useRef<HTMLDivElement>(null);
  const didHighlight = useRef<string | null>(null);

  const sections = useMemo(() => splitSections(content), [content]);

  // All sections are always visible — no truncation needed since we load all messages at once
  const visibleSections = sections;

  // After render, find matching text in DOM and highlight it (scroll handled by parent)
  useEffect(() => {
    if (!highlightQuery || !containerRef.current) return;
    if (didHighlight.current === highlightQuery) return;

    // Small delay to let sections render
    const timer = setTimeout(() => {
      const container = containerRef.current;
      if (!container) return;

      // Clear previous highlights
      container.querySelectorAll("mark[data-search-highlight]").forEach((el) => {
        const parent = el.parentNode;
        if (parent) {
          parent.replaceChild(document.createTextNode(el.textContent || ""), el);
          parent.normalize();
        }
      });

      // Walk text nodes to find the query
      const query = highlightQuery.toLowerCase();
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);

      const nodesToHighlight: { node: Text; startIdx: number; length: number }[] = [];
      while (walker.nextNode()) {
        const textNode = walker.currentNode as Text;
        const text = textNode.textContent || "";
        const idx = text.toLowerCase().indexOf(query);
        if (idx !== -1) {
          nodesToHighlight.push({ node: textNode, startIdx: idx, length: highlightQuery.length });
          // Only highlight first few matches to avoid performance issues
          if (nodesToHighlight.length >= 5) break;
        }
      }

      for (const { node, startIdx, length } of nodesToHighlight) {
        const range = document.createRange();
        range.setStart(node, startIdx);
        range.setEnd(node, startIdx + length);
        const mark = document.createElement("mark");
        mark.setAttribute("data-search-highlight", "true");
        mark.style.backgroundColor = "rgba(251, 191, 36, 0.4)";
        mark.style.borderRadius = "2px";
        mark.style.padding = "1px 0";
        range.surroundContents(mark);
      }

      if (nodesToHighlight.length > 0) {
        didHighlight.current = highlightQuery;
      }
    }, 100);

    return () => clearTimeout(timer);
  }, [highlightQuery, visibleSections]);

  // Reset highlight tracking when query changes
  useEffect(() => {
    if (!highlightQuery) didHighlight.current = null;
  }, [highlightQuery]);

  const compactClasses = compact ? [
    "text-[12px] leading-[1.7]",
    "prose-p:my-1.5 prose-p:text-[12px] prose-p:leading-[1.65]",
    "prose-h1:text-[15px] prose-h1:mt-5 prose-h1:mb-2",
    "prose-h2:text-[13.5px] prose-h2:mt-4 prose-h2:mb-1.5",
    "prose-h3:text-[12.5px] prose-h3:mt-3 prose-h3:mb-1",
    "prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-li:text-[12px]",
    "prose-td:text-[11px] prose-th:text-[10.5px] prose-table:my-2",
    "prose-pre:my-2",
    "prose-blockquote:my-2 prose-hr:my-3",
  ].join(" ") : "";

  const components = useMarkdownComponents(projectPath, compact);
  const sectionClassName = `markdown-body prose prose-sm dark:prose-invert max-w-none prose-code:before:content-none prose-code:after:content-none prose-headings:first:mt-0 prose-blockquote:pl-3 prose-blockquote:border-l-2 prose-blockquote:border-muted-foreground/30 ${compactClasses}`;

  return (
    <div ref={containerRef}>
      {visibleSections.map((section) =>
        folded ? (
          <FoldableSection
            key={section.key}
            section={section}
            components={components}
            className={sectionClassName}
          />
        ) : (
          <MemoSection
            key={section.key}
            content={section.content}
            projectPath={projectPath}
            compact={compact}
            components={components}
            className={sectionClassName}
          />
        )
      )}
    </div>
  );
});
