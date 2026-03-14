import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { getDb, getShareLink, upsertShareLink, deleteShareLink } from "@/lib/db";
import { readSessionMessages } from "@/lib/session-reader";
import { SessionRow, ParsedMessage, ContentBlock } from "@/lib/types";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ sessionId: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { sessionId } = await params;
  const link = getShareLink(sessionId);
  if (!link) return NextResponse.json({ shared: false });
  return NextResponse.json({ shared: true, url: link.url, slug: link.slug });
}

export async function POST(_req: NextRequest, { params }: Params) {
  const { sessionId } = await params;
  const db = getDb();

  const session = db
    .prepare("SELECT * FROM sessions WHERE session_id = ?")
    .get(sessionId) as SessionRow | undefined;
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });

  const messages = readSessionMessages(session.jsonl_path);
  const existing = getShareLink(sessionId);

  const slug = existing?.slug ?? `session-${sessionId.slice(0, 8)}`;
  const html = buildHtml(session, messages);

  // Write HTML to temp file
  mkdirSync(path.join(tmpdir(), "session-shares"), { recursive: true });
  const tmpFile = path.join(tmpdir(), "session-shares", `${slug}.html`);
  writeFileSync(tmpFile, html, "utf-8");

  try {
    const args = ["instant-publish", "deploy", tmpFile, "--slug", slug];
    if (existing?.password) {
      args.push("--password", existing.password);
    }

    const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";
    const { stdout } = await execFileAsync(npxBin, args, {
      timeout: 30_000,
      env: { ...process.env, PATH: process.env.PATH },
    });

    // Parse URL and password from output
    // instant-publish output: "✓ Published: https://chillai.space/p/slug?password=xxx"
    const urlMatch = stdout.match(/https?:\/\/\S+/);
    const passwordMatch = stdout.match(/\?password=([^\s&]+)/);

    if (!urlMatch) {
      return NextResponse.json({ error: "Publish failed: " + stdout }, { status: 500 });
    }

    const url = urlMatch[0];
    const password = passwordMatch?.[1] ?? existing?.password ?? "";

    upsertShareLink(sessionId, slug, password, url);

    return NextResponse.json({ shared: true, url, slug });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { sessionId } = await params;
  deleteShareLink(sessionId);
  return NextResponse.json({ shared: false });
}

// ─── HTML generation ─────────────────────────────────────────────────────────

function extractText(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "thinking") return `<thinking>\n${b.thinking}\n</thinking>`;
      if (b.type === "tool_use") return `[${b.name}]`;
      if (b.type === "tool_result") {
        const c = b.content;
        if (typeof c === "string") return c;
        if (Array.isArray(c)) return extractText(c);
      }
      return "";
    })
    .join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escape a JSON string for safe embedding inside a <script> tag.
 * Prevents "</script>" or "<!--" sequences from breaking out of the tag.
 */
function escapeJsonForScript(json: string): string {
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function buildHtml(session: SessionRow, messages: ParsedMessage[]): string {
  const title = session.generated_title ?? session.custom_name ?? session.first_prompt?.slice(0, 80) ?? "Claude Session";
  const project = session.project_path?.split(/[\\/]/).slice(-2).join("/") ?? "";
  const date = new Date(session.modified_at).toLocaleDateString("en-US", {
    year: "numeric", month: "short", day: "numeric",
  });

  const msgHtml = messages
    .filter((m) => m.type === "user" || m.type === "assistant")
    .map((m) => {
      const isUser = m.type === "user";
      const text = Array.isArray(m.content)
        ? extractText(m.content as ContentBlock[])
        : typeof m.content === "string"
        ? m.content
        : "";

      if (!text.trim()) return "";

      const escapedText = escapeHtml(text).replace(/\n/g, "<br>");
      return `
        <div class="msg ${isUser ? "user" : "assistant"}">
          <div class="role">${isUser ? "You" : "Claude"}</div>
          <div class="body">${escapedText}</div>
        </div>`;
    })
    .filter(Boolean)
    .join("\n");

  // Embed session data for import
  const importPayload = JSON.stringify({
    session_id: session.session_id,
    title,
    project_path: session.project_path,
    model: session.model,
    messages: messages.filter((m) => m.type === "user" || m.type === "assistant"),
  });

  return `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --bg: #ffffff;
    --surface: #f7f7f8;
    --border: #e8e8ec;
    --text: #1a1a1e;
    --text-muted: #6b6b75;
    --badge-bg: #ededf0;
    --user-color: #4f46e5;
    --assistant-color: #059669;
    --msg-border: #ededf0;
    --footer-color: #bbbbc8;
    --link-color: #4f46e5;
    --toggle-bg: #e8e8ec;
  }
  [data-theme="dark"] {
    --bg: #0f0f10;
    --surface: #1a1a1e;
    --border: #2a2a2e;
    --text: #f0f0f2;
    --text-muted: #888892;
    --badge-bg: #1e1e24;
    --user-color: #818cf8;
    --assistant-color: #34d399;
    --msg-border: #1c1c20;
    --footer-color: #444450;
    --link-color: #818cf8;
    --toggle-bg: #2a2a2e;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);line-height:1.6;padding:24px 16px 80px;transition:background .2s,color .2s}
  .container{max-width:760px;margin:0 auto}
  header{padding:24px 0 20px;border-bottom:1px solid var(--border);margin-bottom:24px;display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
  .header-left{flex:1;min-width:0}
  .header-actions{display:flex;align-items:center;gap:8px;flex-shrink:0;margin-top:4px}
  .badge{display:inline-block;font-size:11px;background:var(--badge-bg);color:var(--text-muted);padding:3px 8px;border-radius:20px;margin-bottom:10px}
  h1{font-size:20px;font-weight:600;color:var(--text);margin-bottom:6px}
  .meta{font-size:12px;color:var(--text-muted)}
  .msg{padding:16px 0;border-bottom:1px solid var(--msg-border)}
  .msg:last-child{border-bottom:none}
  .role{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px}
  .user .role{color:var(--user-color)}
  .assistant .role{color:var(--assistant-color)}
  .body{font-size:14px;color:var(--text);white-space:pre-wrap;word-break:break-word;line-height:1.65}
  footer{margin-top:40px;text-align:center;font-size:11px;color:var(--footer-color)}
  a{color:var(--link-color);text-decoration:none}
  .btn{
    height:36px;padding:0 12px;
    border:1px solid var(--border);
    background:var(--toggle-bg);
    border-radius:8px;
    cursor:pointer;
    font-size:13px;
    color:var(--text);
    transition:opacity .15s;
    white-space:nowrap;
  }
  .btn:hover{opacity:.75}
  .btn.primary{background:var(--user-color);color:#fff;border-color:transparent}
  .btn.primary:hover{opacity:.85}
  .import-status{font-size:12px;color:var(--text-muted);margin-top:8px;display:none;text-align:right}
</style>
</head>
<body>
<script id="session-data" type="application/json">${escapeJsonForScript(importPayload)}</script>
<div class="container">
  <header>
    <div class="header-left">
      <div class="badge">Claude Code Session</div>
      <h1>${escapeHtml(title)}</h1>
      <div class="meta">${escapeHtml(project)} · ${date} · ${messages.length} messages</div>
    </div>
    <div class="header-actions">
      <button class="btn primary" onclick="importSession(this)" title="Import this session into your Claude Session Manager">⬇ Import</button>
      <button class="btn" onclick="toggleTheme()" title="Toggle light/dark mode" id="themeBtn">🌙</button>
    </div>
  </header>
  <div id="import-status" class="import-status"></div>
  <div class="messages">
    ${msgHtml}
  </div>
  <footer>Shared via <a href="https://chillai.space">Claude Session Manager</a></footer>
</div>
<script>
  const saved = localStorage.getItem('share-theme') || 'light';
  setTheme(saved);

  function setTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    document.getElementById('themeBtn').textContent = t === 'dark' ? '☀️' : '🌙';
  }
  function toggleTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    setTheme(next);
    localStorage.setItem('share-theme', next);
  }

  function showStatus(msg, ok) {
    const el = document.getElementById('import-status');
    el.textContent = msg;
    el.style.display = 'block';
    el.style.color = ok ? '#059669' : 'var(--text-muted)';
  }

  async function importSession(btn) {
    const payload = JSON.parse(document.getElementById('session-data').textContent);
    btn.disabled = true;
    btn.textContent = '…';
    showStatus('Connecting to Claude Session Manager on localhost:3000…', false);
    try {
      const res = await fetch('http://localhost:3000/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      btn.textContent = '✓ Imported';
      showStatus('Imported! Opening in your session manager…', true);
      setTimeout(() => {
        window.open('http://localhost:3000/claude-sessions/' + data.session_id, '_blank');
      }, 800);
    } catch (e) {
      btn.textContent = '⬇ Import';
      btn.disabled = false;
      showStatus('Session Manager not running on localhost:3000. Make sure it is started.', false);
    }
  }
</script>
</body>
</html>`;
}
