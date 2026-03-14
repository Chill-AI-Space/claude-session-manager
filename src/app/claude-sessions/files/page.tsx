"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { MarkdownContent } from "@/components/MarkdownContent";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileText, File as FilePdf, Send, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

function basename(p: string) { return p.split(/[\\/]/).pop() ?? p; }
function extname(p: string) { const dot = p.lastIndexOf("."); return dot >= 0 ? p.slice(dot) : ""; }
function dirname(p: string) { const idx = p.search(/[\\/][^\\/]*$/); return idx >= 0 ? p.slice(0, idx) : "."; }

interface FileContent {
  type: "text" | "pdf" | "image" | "unknown";
  content?: string;
  ext?: string;
  name?: string;
}

export default function FilesPage() {
  return (
    <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin mr-2" />Loading…</div>}>
      <FilesContent />
    </Suspense>
  );
}

function FilesContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const filePath = searchParams.get("path");

  const [content, setContent] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
  const ext = filePath ? extname(filePath).toLowerCase().slice(1) : "";

  useEffect(() => {
    setContent(null);
    setImageUrl(null);

    if (!filePath) return;

    if (IMAGE_EXTS.has(ext)) {
      setImageUrl(`/api/files/content?path=${encodeURIComponent(filePath)}`);
      return;
    }

    setLoading(true);
    fetch(`/api/files/content?path=${encodeURIComponent(filePath)}`)
      .then((r) => r.json())
      .then(setContent)
      .catch(() => setContent({ type: "unknown" }))
      .finally(() => setLoading(false));
  }, [filePath]);

  const handleSend = async () => {
    if (!reply.trim()) return;
    setSending(true);
    try {
      const message = `File: ${filePath ?? ""}\n\n${reply.trim()}`;
      const cwd = filePath ? dirname(filePath) : undefined;
      const res = await fetch("/api/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, ...(cwd ? { cwd } : {}) }),
      });
      const data = await res.json();
      if (data.session_id) {
        router.push(`/claude-sessions/${data.session_id}`);
      }
    } catch {
      // ignore
    } finally {
      setSending(false);
      setReply("");
    }
  };

  if (!filePath) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground text-sm gap-2">
        <FileText className="h-8 w-8 opacity-30" />
        <span>Select a file from the sidebar</span>
      </div>
    );
  }

  const displayName = basename(filePath);
  const displayPath = filePath;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="border-b border-border px-4 py-3 flex items-center gap-3 shrink-0">
        <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-medium truncate">{displayName}</h2>
          <p className="text-[11px] text-muted-foreground/60 truncate">{displayPath}</p>
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="px-6 py-5 max-w-[720px] mx-auto w-full">
          {loading && (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          )}

          {imageUrl && (
            <img
              src={imageUrl}
              alt={displayName}
              className="max-w-full rounded border border-border"
            />
          )}

          {content?.type === "pdf" && (
            <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
              <FilePdf className="h-12 w-12 opacity-40" />
              <span className="text-sm">{content.name || displayName}</span>
              <span className="text-xs opacity-60">PDF preview not supported — ask Claude about it below</span>
            </div>
          )}

          {content?.type === "text" && content.content !== undefined && (
            content.ext === "md" || content.ext === "mdx" ? (
              <MarkdownContent content={content.content} />
            ) : (
              <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap break-words text-foreground/80">
                {content.content}
              </pre>
            )
          )}

          {content?.type === "unknown" && (
            <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
              <FileText className="h-8 w-8 opacity-30" />
              <span className="text-sm">Cannot preview this file type</span>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Reply input */}
      <div className="border-t border-border px-6 py-3 shrink-0">
        <div className="flex gap-2 items-end max-w-[720px] mx-auto">
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            placeholder="Ask Claude about this file…"
            rows={3}
            className="flex-1 resize-none bg-muted/30 border border-input rounded px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <Button
            size="icon"
            variant="ghost"
            className="h-9 w-9 shrink-0"
            onClick={handleSend}
            disabled={!reply.trim() || sending}
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
