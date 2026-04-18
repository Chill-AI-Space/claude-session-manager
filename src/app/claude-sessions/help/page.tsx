"use client";

// v1.1.1 — test release for Update button verification
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

function Section({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-between w-full px-4 py-3 text-left hover:bg-muted/30 transition-colors"
      >
        <span className="text-sm font-semibold">{title}</span>
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
      </button>
      {open && <div className="px-4 pb-4 pt-1 border-t border-border/50 space-y-3 text-sm">{children}</div>}
    </section>
  );
}

function Code({ children }: { children: string }) {
  return <code className="font-mono bg-muted px-1.5 py-0.5 rounded text-[12px]">{children}</code>;
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary text-[11px] font-bold flex items-center justify-center mt-0.5">{n}</span>
      <div className="flex-1 text-muted-foreground leading-relaxed">{children}</div>
    </div>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return <div className="bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2 text-xs text-amber-700 dark:text-amber-400 leading-relaxed">{children}</div>;
}

function Block({ children }: { children: React.ReactNode }) {
  return <div className="bg-muted/60 border border-border rounded px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{children}</div>;
}

export default function HelpPage() {
  return (
    <div className="flex-1 overflow-y-auto px-8 py-8 max-w-2xl mx-auto w-full">
      <h1 className="text-lg font-semibold mb-1">Help & Setup Guide</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Permissions, troubleshooting, and keyboard shortcuts for Claude Session Manager
      </p>

      <div className="space-y-3">

        {/* ── Permissions ──────────────────────────────────────── */}
        <Section title="🔐 Permissions — what they are and why" defaultOpen>
          <div className="space-y-4">

            <div className="space-y-2">
              <p className="font-medium">1. Accessibility (macOS)</p>
              <p className="text-muted-foreground leading-relaxed">
                Used by the <strong>Focus Terminal</strong> button — it sends an AppleScript command to bring your terminal window to the front. macOS requires Accessibility permission for any app that controls other windows.
              </p>
              <div className="space-y-1.5 text-muted-foreground">
                <Step n={1}>Open <strong>System Settings → Privacy &amp; Security → Accessibility</strong></Step>
                <Step n={2}>Click the <strong>+</strong> button and add your terminal app. If <strong>iTerm2</strong> is installed, Session Manager prefers it automatically on macOS.</Step>
                <Step n={3}>Also keep <strong>node</strong> in the list — it's the server process that sends the AppleScript command</Step>
              </div>
              <Warning>Without this: the Focus Terminal button returns an error. Everything else works normally.</Warning>
            </div>

            <div className="space-y-2">
              <p className="font-medium">2. Browser Notifications</p>
              <p className="text-muted-foreground leading-relaxed">
                Used to alert you when Claude finishes responding and is waiting for your reply — especially useful when the tab is in the background.
              </p>
              <div className="space-y-1.5 text-muted-foreground">
                <Step n={1}>Go to <strong>Settings → Notifications → Browser notification</strong> and enable the toggle</Step>
                <Step n={2}>Your browser will show a one-time permission prompt — click <strong>Allow</strong></Step>
                <Step n={3}>If you accidentally clicked Block: in Chrome go to <strong>Settings → Privacy → Site Settings → Notifications</strong>, find <Code>localhost:3000</Code>, change to Allow</Step>
              </div>
            </div>

            <div className="space-y-2">
              <p className="font-medium">3. No extra permissions needed for</p>
              <ul className="text-muted-foreground space-y-1 ml-4 list-disc text-xs">
                <li>Reading sessions (just reads <Code>~/.claude/projects/</Code> files)</li>
                <li>Web replies (spawns <Code>claude --resume</Code> as a subprocess)</li>
                <li>Sound notifications (Web Audio API, no permission needed)</li>
              </ul>
            </div>
          </div>
        </Section>

        {/* ── Claude CLI not found ─────────────────────────────── */}
        <Section title="⚠️ Claude CLI not found — fix PATH issues">
          <div className="space-y-4">
            <p className="text-muted-foreground leading-relaxed">
              The most common setup problem: the server can't find the <Code>claude</Code> command even though you have Claude Code installed. This happens because the terminal where you <em>installed</em> it had a different PATH than where you <em>run the server</em>.
            </p>

            <div className="space-y-2">
              <p className="font-medium">Step 1 — find where claude is installed</p>
              <Block>which claude           # macOS / Linux
where claude           # Windows CMD
Get-Command claude     # Windows PowerShell</Block>
              <p className="text-muted-foreground text-xs">Example output: <Code>/Users/name/.npm-global/bin/claude</Code> or <Code>C:\Users\name\AppData\Roaming\npm\claude</Code></p>
            </div>

            <div className="space-y-2">
              <p className="font-medium">Step 2 — add to PATH permanently</p>
              <p className="text-muted-foreground text-xs mb-1">macOS / Linux (add to <Code>~/.zshrc</Code> or <Code>~/.bashrc</Code>):</p>
              <Block>export PATH="$PATH:$(npm prefix -g)/bin"</Block>
              <p className="text-muted-foreground text-xs mt-2 mb-1">Then reload:</p>
              <Block>source ~/.zshrc   # or restart terminal</Block>
            </div>

            <div className="space-y-2">
              <p className="font-medium">Step 3 — check from the server's shell</p>
              <Block>{"node -e \"const {execSync}=require('child_process'); console.log(execSync('which claude').toString())\""}</Block>
              <p className="text-muted-foreground text-xs">If this prints a path, the server will find it. If it says "not found", the server's Node.js process doesn't inherit your shell's PATH.</p>
            </div>

            <div className="space-y-2">
              <p className="font-medium">Alternative: set NODE_PATH in .env.local</p>
              <p className="text-muted-foreground text-xs mb-1">Create or edit <Code>.env.local</Code> in the project root:</p>
              <Block>PATH=/usr/local/bin:/Users/yourname/.npm-global/bin:$PATH</Block>
              <Warning>The server must be restarted after changing .env.local</Warning>
            </div>
          </div>
        </Section>

        {/* ── Windows Setup ───────────────────────────────────── */}
        <Section title="🪟 Windows — setup guide and testing checklist">
          <div className="space-y-4">

            <div className="space-y-2">
              <p className="font-medium">What works on Windows</p>
              <ul className="text-muted-foreground space-y-1 ml-4 list-disc text-xs leading-relaxed">
                <li>Browsing and searching all sessions ✅</li>
                <li>Viewing full message history ✅</li>
                <li>Sending web replies to Claude ✅</li>
                <li>Gemini AI search ✅</li>
                <li>Sound + browser notifications ✅</li>
                <li>File browser ✅</li>
              </ul>
            </div>

            <div className="space-y-2">
              <p className="font-medium">What doesn't work on Windows</p>
              <ul className="text-amber-700 dark:text-amber-400 space-y-1 ml-4 list-disc text-xs leading-relaxed">
                <li>Active session detection (requires <Code>ps</Code> / <Code>lsof</Code>) — sessions show as inactive</li>
                <li>Focus Terminal button — requires AppleScript / macOS</li>
                <li>Open in Terminal button — macOS/Windows only</li>
                <li>Kill terminal button — SIGTERM not supported</li>
              </ul>
            </div>

            <div className="space-y-2">
              <p className="font-medium">Prerequisites</p>
              <div className="space-y-1.5 text-muted-foreground">
                <Step n={1}>Install Node.js 20+ from <Code>nodejs.org</Code></Step>
                <Step n={2}>Install Claude Code: <Code>npm install -g @anthropic-ai/claude-code</Code></Step>
                <Step n={3}>Clone the repo and run: <Code>npm install</Code></Step>
                <Step n={4}>Create <Code>.env.local</Code> with your Gemini key if needed</Step>
                <Step n={5}>Build: <Code>npm run build</Code></Step>
                <Step n={6}>Start: <Code>npm run start</Code> (use Task Scheduler or PM2 for auto-start)</Step>
              </div>
            </div>

            <div className="space-y-2">
              <p className="font-medium">Finding sessions on Windows</p>
              <p className="text-muted-foreground text-xs leading-relaxed">Sessions are stored in <Code>%USERPROFILE%\.claude\projects\</Code>. The scanner reads <Code>process.env.USERPROFILE</Code> automatically.</p>
              <Warning>If sessions don't appear: open Settings → System Setup and check if the path is resolved correctly. The scanner looks in <Code>HOME/.claude/projects/</Code> — make sure USERPROFILE or HOME env var points to your Windows user folder.</Warning>
            </div>

            <div className="space-y-2">
              <p className="font-medium">Windows testing checklist</p>
              <ul className="text-muted-foreground space-y-1 ml-4 list-disc text-xs leading-relaxed">
                <li>Open Settings → check System Setup panel (all checks pass?)</li>
                <li>Click "Scan sessions" — sessions appear in the list?</li>
                <li>Open a session — messages load correctly?</li>
                <li>Try sending a web reply — Claude responds?</li>
                <li>Try Gemini search (if API key configured)</li>
                <li>Check that active session indicator is grey/inactive (expected on Windows)</li>
                <li>Focus Terminal button — confirm it shows "not available" rather than crashing</li>
                <li>File browser — can you browse local folders?</li>
              </ul>
            </div>

            <div className="space-y-2">
              <p className="font-medium">Common Windows PATH fix</p>
              <Block>npm config get prefix
# Copy the output path, e.g. C:\Users\name\AppData\Roaming\npm

# Add to System Environment Variables → Path:
C:\Users\name\AppData\Roaming\npm</Block>
              <p className="text-muted-foreground text-xs mt-1">After adding to PATH, restart the terminal and run <Code>claude --version</Code> to verify.</p>
            </div>
          </div>
        </Section>

        {/* ── Keyboard Shortcuts ───────────────────────────────── */}
        <Section title="⌨️ Keyboard Shortcuts" defaultOpen>
          {[
            { group: "Session view", items: [
              { keys: ["Esc"], description: "Stop Claude response (cancel streaming)" },
              { keys: ["⌘L"], description: "Focus reply input" },
              { keys: ["⌘K"], description: "Clear extra messages from view" },
              { keys: ["⌘Enter"], description: "Send message" },
              { keys: ["Enter / ⇧Enter"], description: "New line in message" },
            ]},
            { group: "Tips", items: [
              { keys: ["Drop file"], description: "Drag a file into reply box → inserts server path" },
              { keys: ["Globe icon"], description: "Start a session directly in the browser — no terminal needed" },
              { keys: ["Search bar"], description: "Auto-switches to content search if no title matches" },
              { keys: ["$ icon"], description: "Deep AI search with Gemini across all session content" },
              { keys: ["⚙ Settings ▸"], description: "Click to expand settings / utility links at bottom of sidebar" },
            ]},
          ].map((group) => (
            <div key={group.group} className="space-y-1">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide pt-1">{group.group}</p>
              <div className="border border-border rounded-md overflow-hidden">
                {group.items.map((item, i) => (
                  <div key={i} className="flex items-center justify-between px-3 py-2 text-sm border-b border-border/50 last:border-0 hover:bg-muted/20">
                    <span className="text-foreground/80">{item.description}</span>
                    <div className="shrink-0 ml-4 flex gap-1">
                      {item.keys.map((k, ki) => (
                        <kbd key={ki} className="inline-flex items-center justify-center min-w-[24px] h-6 px-1.5 text-xs font-mono bg-muted border border-border rounded shadow-sm">{k}</kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </Section>

        {/* ── Terminal vs Web ────────────────────────────────── */}
        <Section title="🔀 Terminal vs Web — how replies work differently">
          <div className="space-y-4">

            <div className="space-y-2">
              <p className="font-medium">Two ways to talk to Claude</p>
              <p className="text-muted-foreground leading-relaxed">
                Claude Code can run in two fundamentally different modes, and they behave differently.
                Understanding this helps explain why a session might "stall" in the web UI but work fine in the terminal.
              </p>
            </div>

            <div className="border border-border rounded-md overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium"></th>
                    <th className="px-3 py-2 text-left font-medium">Terminal (interactive)</th>
                    <th className="px-3 py-2 text-left font-medium">Web UI (non-interactive)</th>
                  </tr>
                </thead>
                <tbody className="text-muted-foreground divide-y divide-border/50">
                  <tr>
                    <td className="px-3 py-2 font-medium text-foreground/80">How it runs</td>
                    <td className="px-3 py-2"><Code>claude</Code> — long-lived process, stays open</td>
                    <td className="px-3 py-2"><Code>claude -p "msg" --resume ID</Code> — one-shot, exits after responding</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 font-medium text-foreground/80">Turns</td>
                    <td className="px-3 py-2">Unlimited — Claude keeps working until done or asks a question</td>
                    <td className="px-3 py-2">Limited by <Code>--max-turns</Code> (default 80). After that, Claude stops even if not done</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 font-medium text-foreground/80">Permissions</td>
                    <td className="px-3 py-2">Asks in terminal. You approve or deny interactively</td>
                    <td className="px-3 py-2">Needs <Code>--dangerously-skip-permissions</Code> or Claude can{"'"}t use tools that require approval</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 font-medium text-foreground/80">Connection</td>
                    <td className="px-3 py-2">Direct stdin/stdout — rock solid</td>
                    <td className="px-3 py-2">SSE stream over HTTP — can drop if network hiccups, proxy timeout, or long silence</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 font-medium text-foreground/80">When Claude "stops"</td>
                    <td className="px-3 py-2">Just type and continue</td>
                    <td className="px-3 py-2">Send a new reply — each reply is a fresh <Code>claude -p</Code> invocation</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="space-y-2">
              <p className="font-medium">Why web replies might stop early</p>
              <ul className="text-muted-foreground space-y-2 ml-4 list-disc text-xs leading-relaxed">
                <li>
                  <strong>Max turns reached:</strong> Claude used all allowed tool-use cycles.
                  Increase <em>Max turns per reply</em> in Settings (default: 80, max: 200).
                </li>
                <li>
                  <strong>Claude chose to stop:</strong> In <Code>-p</Code> mode, Claude sometimes reports what it{"'"}s about to do
                  instead of just doing it (e.g. "I{"'"}ll write the file now") and exits. This is Claude{"'"}s own behavior in
                  non-interactive mode. Just send "continue" or "go ahead" as a follow-up.
                </li>
                <li>
                  <strong>Permission required:</strong> Without <Code>--dangerously-skip-permissions</Code>,
                  Claude can{"'"}t execute tools that require approval (like Bash commands). Enable the
                  skip-permissions toggle in Settings if you trust the session.
                </li>
                <li>
                  <strong>Connection dropped:</strong> If no data flows for ~45 seconds, the SSE stream may time out.
                  The web UI detects this and shows "Connection lost" — it{"'"}ll auto-recover by refreshing session data.
                  Keepalive pings run every 15s to prevent this, but network issues can still interrupt.
                </li>
              </ul>
            </div>

            <div className="space-y-2">
              <p className="font-medium">Best practices</p>
              <ul className="text-muted-foreground space-y-1.5 ml-4 list-disc text-xs leading-relaxed">
                <li>For complex multi-step tasks: use the terminal (interactive mode is more reliable for long tasks)</li>
                <li>For quick follow-ups and replies: the web UI works great — fast and convenient</li>
                <li>Enable <em>Skip Permissions</em> and set <em>Max turns</em> to 100+ for autonomous work via web</li>
                <li>Enable <em>Auto-retry on crash</em> to automatically recover from mid-execution failures</li>
                <li>The web UI shows tool names while Claude works (e.g. "Using tool: Bash") so you know it{"'"}s not stuck</li>
              </ul>
            </div>

            <Warning>
              Terminal and web sessions share the same JSONL file. If a terminal Claude process is running
              and you reply from the web, both may write to the session simultaneously. Enable{" "}
              <em>Auto-kill terminal on reply</em> in Settings to avoid conflicts.
            </Warning>
          </div>
        </Section>

        {/* ── About ───────────────────────────────────────────── */}
        <div className="border border-border rounded-lg px-4 py-3 text-xs text-muted-foreground space-y-1">
          <p className="font-medium text-foreground/70">Claude Session Manager</p>
          <p>Browse, search, and reply to Claude Code sessions from a web UI.</p>
          <p>Sessions stored in <Code>~/.claude/projects/</Code></p>
        </div>

      </div>
    </div>
  );
}
