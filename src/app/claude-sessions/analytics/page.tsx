"use client";

import React, { useEffect, useState, useCallback } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import { Loader2, TrendingUp, MessageSquare, Zap, DollarSign, Search, Clock, AlertTriangle, Users, Coins, Brain, Workflow, ChevronDown, ChevronUp, X, Repeat, Bookmark, Copy, Check, Sparkles, Pencil, Eye, ExternalLink } from "lucide-react";
import { formatTokens } from "@/lib/utils";

interface AnalyticsData {
  summary: {
    total_sessions: number;
    total_input: number;
    total_output: number;
    active_days: number;
    total_cost: number;
  };
  daily: Array<{
    day: string; sessions: number; input_tokens: number; output_tokens: number; cost: number;
  }>;
  projects: Array<{
    label: string; sessions: number; input_tokens: number; output_tokens: number; cost: number;
  }>;
  models: Array<{
    model: string; sessions: number; input_tokens: number; output_tokens: number; cost: number;
  }>;
  top_sessions: Array<{
    session_id: string; title: string; project: string; model: string;
    total_input_tokens: number; total_output_tokens: number; modified_at: string;
  }>;
}

function StatCard({
  icon: Icon, label, value, sub, color,
}: {
  icon: React.ElementType; label: string; value: string; sub?: string; color: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className={`flex items-center gap-2 mb-2 ${color}`}>
        <Icon className="h-4 w-4" />
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <div className="text-2xl font-bold text-foreground">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

const CHART_COLORS = [
  "#6366f1", "#8b5cf6", "#a78bfa", "#c4b5fd",
  "#818cf8", "#7c3aed", "#4f46e5", "#4338ca",
];

function fmt$(n: number) {
  if (n >= 10000) return `$${(n / 1000).toFixed(1)}k`;
  if (n >= 1000) return `$${(n / 1000).toFixed(2)}k`;
  return `$${n.toFixed(0)}`;
}

const DAY_LABELS: Record<string, string> = {
  "0": "Sun", "1": "Mon", "2": "Tue", "3": "Wed",
  "4": "Thu", "5": "Fri", "6": "Sat",
};

function shortDay(dateStr: string) {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [period, setPeriod] = useState(30);
  const [view, setView] = useState<"tokens" | "sessions" | "cost">("tokens");

  useEffect(() => {
    setData(null);
    fetch(`/api/analytics?period=${period}`)
      .then((r) => r.json())
      .then(setData);
  }, [period]);

  if (!data) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const { summary, daily, projects, models, top_sessions } = data;
  const totalTokens = (summary.total_input ?? 0) + (summary.total_output ?? 0);

  const chartData = daily.map((d) => ({
    ...d,
    label: shortDay(d.day),
    total_tokens: d.input_tokens + d.output_tokens,
  }));

  const chartKey = view === "cost" ? "cost"
    : view === "sessions" ? "sessions"
    : "total_tokens";

  const chartFormatter = view === "cost"
    ? (v: number) => fmt$(v)
    : view === "sessions"
    ? (v: number) => `${v} sessions`
    : (v: number) => formatTokens(v);

  return (
    <div className="flex-1 overflow-y-auto px-8 py-8 max-w-5xl mx-auto w-full">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold">Usage Analytics</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            API-equivalent cost estimate — Claude Code is subscription-based
          </p>
        </div>
        <div className="flex gap-1 text-xs bg-muted/40 rounded-md p-0.5">
          {([7, 30, 90] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1 rounded transition-colors ${
                period === p
                  ? "bg-background text-foreground shadow-sm font-medium"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {p}d
            </button>
          ))}
        </div>
      </div>

      {/* Deep Analytics — templates + input at the top */}
      <DeepAnalytics />

      {/* Charts section below */}
      <div className="mt-2">
        {/* Stats row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <StatCard
            icon={DollarSign}
            label="Est. API cost"
            value={fmt$(summary.total_cost)}
            sub="all time, Anthropic list prices"
            color="text-amber-500"
          />
          <StatCard
            icon={Zap}
            label="Total tokens"
            value={formatTokens(totalTokens)}
            sub={`${formatTokens(summary.total_input)} in · ${formatTokens(summary.total_output)} out`}
            color="text-violet-500"
          />
          <StatCard
            icon={MessageSquare}
            label="Sessions"
            value={String(summary.total_sessions)}
            sub={`${summary.active_days} active days`}
            color="text-blue-500"
          />
          <StatCard
            icon={TrendingUp}
            label="Avg tokens/day"
            value={formatTokens(Math.round(totalTokens / Math.max(summary.active_days, 1)))}
            sub={`last ${period} days view`}
            color="text-green-500"
          />
        </div>

        {/* Daily chart */}
        <div className="border border-border rounded-lg p-4 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold">Daily Usage</h2>
            <div className="flex gap-1 text-xs bg-muted/40 rounded-md p-0.5">
              {(["tokens", "sessions", "cost"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`px-2.5 py-0.5 rounded transition-colors capitalize ${
                    view === v
                      ? "bg-background text-foreground shadow-sm font-medium"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chartData} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tickFormatter={chartFormatter}
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                axisLine={false}
                tickLine={false}
                width={60}
              />
              <Tooltip
                formatter={(v: unknown) => [chartFormatter(typeof v === "number" ? v : 0), view]}
                labelStyle={{ fontSize: 11 }}
                contentStyle={{
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  fontSize: 11,
                }}
              />
              <Bar dataKey={chartKey} radius={[2, 2, 0, 0]}>
                {chartData.map((_, i) => (
                  <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} fillOpacity={0.85} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          {/* Top projects */}
          <div className="border border-border rounded-lg p-4">
            <h2 className="text-sm font-semibold mb-3">Top Projects (last {period}d)</h2>
            {projects.length === 0 ? (
              <p className="text-xs text-muted-foreground">No data</p>
            ) : (
              <div className="space-y-2">
                {projects.slice(0, 8).map((p, i) => {
                  const maxInput = projects[0].input_tokens;
                  const pct = maxInput > 0 ? (p.input_tokens / maxInput) * 100 : 0;
                  return (
                    <div key={i}>
                      <div className="flex items-center justify-between text-xs mb-0.5">
                        <span className="text-foreground/80 truncate max-w-[60%]">{p.label}</span>
                        <span className="text-muted-foreground shrink-0 ml-2">
                          {formatTokens(p.input_tokens)} · {p.sessions}s
                        </span>
                      </div>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${pct}%`,
                            background: CHART_COLORS[i % CHART_COLORS.length],
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Models */}
          <div className="border border-border rounded-lg p-4">
            <h2 className="text-sm font-semibold mb-3">Model Breakdown</h2>
            <div className="space-y-3">
              {models.filter(m => m.model !== '<synthetic>' && m.model !== 'unknown').map((m, i) => {
                const totalCost = models.reduce((s, x) => s + x.cost, 0);
                const pct = totalCost > 0 ? (m.cost / totalCost) * 100 : 0;
                const shortModel = m.model.replace("claude-", "").replace(/-\d{8}$/, "");
                return (
                  <div key={i}>
                    <div className="flex items-center justify-between text-xs mb-0.5">
                      <span className="font-mono text-foreground/80">{shortModel}</span>
                      <span className="text-muted-foreground">
                        {fmt$(m.cost)} · {m.sessions} sessions
                      </span>
                    </div>
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${pct}%`,
                          background: CHART_COLORS[i % CHART_COLORS.length],
                        }}
                      />
                    </div>
                    <div className="text-[10px] text-muted-foreground/60 mt-0.5">
                      {formatTokens(m.input_tokens)} in · {formatTokens(m.output_tokens)} out
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Top sessions table */}
        <div className="border border-border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-3">Heaviest Sessions (by input tokens)</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b border-border">
                  <th className="text-left pb-2 font-medium">Session</th>
                  <th className="text-left pb-2 font-medium">Project</th>
                  <th className="text-right pb-2 font-medium">Input</th>
                  <th className="text-right pb-2 font-medium">Output</th>
                  <th className="text-right pb-2 font-medium">Est. Cost</th>
                </tr>
              </thead>
              <tbody>
                {top_sessions.map((s) => {
                  const cost = calcClientCost(s.model, s.total_input_tokens, s.total_output_tokens);
                  return (
                    <tr
                      key={s.session_id}
                      className="border-b border-border/50 last:border-0 hover:bg-muted/20 cursor-pointer"
                      onClick={() => window.location.href = `/claude-sessions/${s.session_id}`}
                    >
                      <td className="py-1.5 pr-3 max-w-[200px]">
                        <span className="truncate block text-foreground/80">
                          {s.title || s.session_id.slice(0, 8)}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3 text-muted-foreground max-w-[160px]">
                        <span className="truncate block">
                          {s.project?.split(/[\\/]/).slice(-2).join("/") ?? "—"}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3 text-right font-mono">
                        {formatTokens(s.total_input_tokens)}
                      </td>
                      <td className="py-1.5 pr-3 text-right font-mono text-muted-foreground">
                        {formatTokens(s.total_output_tokens)}
                      </td>
                      <td className="py-1.5 text-right font-mono text-amber-600 dark:text-amber-400">
                        {fmt$(cost)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

// Client-side cost calc (mirrors server)
function calcClientCost(model: string, input: number, output: number): number {
  const prices: Record<string, { input: number; output: number }> = {
    "claude-opus-4-6":    { input: 15, output: 75 },
    "claude-sonnet-4-6":  { input: 3,  output: 15 },
  };
  const p = prices[model] ?? { input: 3, output: 15 };
  return (input / 1_000_000) * p.input + (output / 1_000_000) * p.output;
}

// ── Deep Analytics ──────────────────────────────────────────────

interface ReportTemplate {
  id: string;
  title: string;
  subtitle: string;
  icon: string;
  color: string;
  prompt: string;
}

interface SavedReport {
  id: string;
  query_id: string;
  title: string;
  created_at: string;
  html: string;
}

const REPORT_TEMPLATES: ReportTemplate[] = [
  { id: "productivity-by-hour", title: "Productivity", subtitle: "By hour of day", icon: "clock", color: "text-blue-500 bg-blue-500/10",
    prompt: "When am I most productive with Claude? Show sessions, messages, and tool calls by hour of day" },
  { id: "compact-timing-analysis", title: "Context Loss", subtitle: "Auto-compact analysis", icon: "brain", color: "text-violet-500 bg-violet-500/10",
    prompt: "How much context do I lose to auto-compaction? Show pre/post token sizes, reduction rates, and which projects compact most" },
  { id: "high-correction-sessions", title: "Friction Points", subtitle: "Correction-heavy sessions", icon: "alert", color: "text-amber-500 bg-amber-500/10",
    prompt: "Which sessions had the most back-and-forth corrections? Show high user-to-assistant ratio sessions" },
  { id: "collaboration-topics", title: "Collaboration", subtitle: "People & teams", icon: "users", color: "text-green-500 bg-green-500/10",
    prompt: "Who do I work with in my sessions? Show mentions of people, teams, clients across projects" },
  { id: "model-efficiency", title: "Model Efficiency", subtitle: "Opus vs Sonnet", icon: "coins", color: "text-rose-500 bg-rose-500/10",
    prompt: "How does Opus compare to Sonnet? Show output, tool calls, session duration, and tokens/second by model" },
  { id: "weekly-trends", title: "Weekly Trends", subtitle: "Usage over time", icon: "trending", color: "text-cyan-500 bg-cyan-500/10",
    prompt: "How has my Claude usage changed week over week? Show sessions, messages, tokens, and projects touched" },
  { id: "tool-usage-efficiency", title: "Tool Usage", subtitle: "Built-in vs MCP", icon: "tool", color: "text-indigo-500 bg-indigo-500/10",
    prompt: "Which tools do I use most? Show built-in vs MCP breakdown and tool usage by project" },
  { id: "user-response-time", title: "Response Time", subtitle: "Your reply speed", icon: "timer", color: "text-teal-500 bg-teal-500/10",
    prompt: "How quickly do I reply to Claude? Show my response time by hour of day and by project" },
  { id: "repetitive-misunderstandings", title: "Misunderstandings", subtitle: "Repeated mismatch patterns", icon: "repeat", color: "text-orange-500 bg-orange-500/10",
    prompt: "Where does Claude repeatedly misunderstand me? Show sessions with many short corrections and projects with chronic mismatch patterns" },
  { id: "knowledge-to-save", title: "Knowledge to Save", subtitle: "Should be rules or guides", icon: "bookmark", color: "text-emerald-500 bg-emerald-500/10",
    prompt: "Which projects need better CLAUDE.md rules? Show chronic correction patterns, repeating tasks, and tool overuse that should be codified" },
];

function getIcon(icon: string) {
  switch (icon) {
    case "clock": return <Clock className="h-5 w-5" />;
    case "brain": return <Brain className="h-5 w-5" />;
    case "alert": return <AlertTriangle className="h-5 w-5" />;
    case "users": return <Users className="h-5 w-5" />;
    case "coins": return <Coins className="h-5 w-5" />;
    case "trending": return <TrendingUp className="h-5 w-5" />;
    case "tool": return <Workflow className="h-5 w-5" />;
    case "timer": return <Zap className="h-5 w-5" />;
    case "repeat": return <Repeat className="h-5 w-5" />;
    case "bookmark": return <Bookmark className="h-5 w-5" />;
    default: return <Search className="h-5 w-5" />;
  }
}

function projName(p: string | null): string {
  if (!p) return "\u2014";
  if (p.includes("GitHub-")) return p.split("GitHub-").pop()!;
  // Convert project dir format (leading dash + dashes as separators) to readable path
  const cleaned = p.replace(/^-/, "/").replace(/-/g, "/");
  return cleaned.startsWith("/Users/") || cleaned.startsWith("/home/") || cleaned.match(/^\/[A-Z]:\//)
    ? "~/" + cleaned.split("/").slice(3).join("/")
    : cleaned;
}

function genPromptForRow(row: Record<string, unknown>, sectionTitle?: string): string | null {
  const proj = row.project_dir as string | undefined;
  const sid = row.session_id as string | undefined;
  const fp = row.first_prompt as string | undefined;
  const p = proj ? projName(proj) : null;
  const model = row.model as string | undefined;
  const keys = Object.keys(row);

  // Helper to build context string from row data
  const ctx = (fields: string[]) =>
    fields
      .filter((f) => row[f] !== undefined && row[f] !== null)
      .map((f) => {
        const v = row[f];
        const label = f.replace(/_/g, " ");
        if (typeof v === "number" && f.includes("token")) return `${label}: ${formatTokens(v as number)}`;
        if (typeof v === "number" && (f.includes("seconds") || f.includes("duration"))) {
          const n = v as number;
          return `${label}: ${n > 3600 ? (n/3600).toFixed(1)+"h" : n > 60 ? Math.round(n/60)+"m" : n+"s"}`;
        }
        return `${label}: ${v}`;
      })
      .join(", ");

  // Session-specific rows (have session_id)
  if (sid) {
    const sessionRef = `session ${sid.slice(0, 12)}`;
    const projRef = p ? ` in project "${p}"` : "";
    const promptRef = fp ? `\nFirst prompt was: "${fp.slice(0, 120)}"` : "";

    // Correction/mismatch sessions
    if (row.short_corrections !== undefined || row.correction_pct !== undefined) {
      return `Analyze ${sessionRef}${projRef}. This session had ${row.short_corrections ?? "many"} short corrections (${row.correction_pct ?? "?"}% of user messages). Read the session JSONL at ~/.claude/projects/ and identify: 1) What exactly was misunderstood 2) The root cause pattern 3) A specific CLAUDE.md rule to prevent this. ${ctx(["message_count", "duration_seconds", "compact_count"])}${promptRef}`;
    }
    // High back-and-forth
    if (row.user_to_assistant_ratio !== undefined) {
      return `Analyze ${sessionRef}${projRef}. This session had unusually high back-and-forth (ratio ${row.user_to_assistant_ratio}). ${ctx(["user_message_count", "assistant_message_count", "compact_count", "total_output_tokens"])}. Read the JSONL and identify: what caused the excessive iterations? Suggest improvements.${promptRef}`;
    }
    // High tool usage
    if (row.tools_per_message !== undefined) {
      return `Analyze ${sessionRef}${projRef}. This session used ${row.tool_call_count} tool calls across ${row.message_count} messages (${row.tools_per_message} tools/message). Read the JSONL and identify: which tools were overused, were there failed attempts or retries, and what CLAUDE.md rules would make this more efficient?${promptRef}`;
    }
    // Compact/context loss
    if (row.pre_input_tokens !== undefined && row.post_input_tokens !== undefined) {
      return `Analyze ${sessionRef}${projRef}. A compaction event reduced context from ${formatTokens(row.pre_input_tokens as number)} to ${formatTokens(row.post_input_tokens as number)} tokens (${row.reduction_pct}% reduction, summary: ${row.summary_length} chars). Read the JSONL around line ${row.line_number ?? "?"} and assess: what important context was lost? Was the summary adequate?${promptRef}`;
    }
    // Token waste / cache miss
    if (row.cache_hit_pct !== undefined) {
      return `Analyze ${sessionRef}${projRef}. Cache hit rate was only ${row.cache_hit_pct}% (${ctx(["total_input_tokens", "total_cache_read_tokens", "total_cache_creation_tokens"])}). Why was caching ineffective? Were there many unique prompts or tool results that couldn't be cached?${promptRef}`;
    }
    // Report/deliverable sessions
    if (row.total_output_tokens !== undefined && !row.short_corrections && !row.tools_per_message && !row.user_to_assistant_ratio) {
      return `Show me what was produced in ${sessionRef}${projRef}. ${ctx(["total_output_tokens", "duration_seconds", "model"])}. Read the JSONL and summarize: what was the task, what was delivered, and was the output useful?${promptRef}`;
    }
  }

  // Project-level rows (no session_id, have project_dir)
  if (p && !sid) {
    // Chronic problems / knowledge to save
    if (row.problem_sessions !== undefined || row.problem_session_pct !== undefined) {
      return `Project "${p}" has chronic issues: ${row.problem_sessions}/${row.total_sessions} sessions are problematic (${row.problem_session_pct}% rate, avg ${row.avg_corrections_per_session} corrections/session). Read the CLAUDE.md for this project and the last 5 session JSONLs. Generate specific rules covering: coding conventions, architecture patterns, common mistakes, and workflow preferences that would reduce corrections.`;
    }
    // Project tool patterns
    if (row.tool_name !== undefined && row.calls_per_session !== undefined) {
      return `In project "${p}", the tool "${row.tool_name}" averages ${row.calls_per_session} calls/session across ${row.sessions} sessions (${row.total_calls} total). Analyze: is this overuse? Are there retries or failures driving the count? Suggest CLAUDE.md rules to optimize (e.g., file path patterns, search strategies, cached results).`;
    }
    // Project cost/token analysis
    if (row.output_tokens !== undefined || row.avg_output !== undefined) {
      return `Analyze project "${p}" efficiency: ${ctx(keys.filter(k => k !== "project_dir" && k !== "models_used"))}. Compare to other projects — is this project unusually expensive or inefficient? What patterns could reduce cost?`;
    }
    // Sidechain/correction patterns
    if (row.sidechain_pct !== undefined || row.total_short_corrections !== undefined) {
      return `Project "${p}" has high correction rates: ${ctx(["sessions", "total_short_corrections", "avg_corrections_per_session", "avg_correction_ratio"])}. Read recent session JSONLs and identify the recurring misunderstanding patterns. Generate CLAUDE.md rules to prevent them.`;
    }
    // Compact-heavy projects
    if (row.compacts !== undefined && row.avg_pre !== undefined) {
      return `Project "${p}" triggers frequent compaction: ${row.compacts} compacts with avg context ${formatTokens(row.avg_pre as number)} → ${formatTokens(row.avg_post as number)} (${row.avg_reduction_pct}% reduction). Analyze: are sessions too long? Should tasks be split differently? Suggest workflow changes to stay under the context limit.`;
    }
    // Generic project stats
    return `Deep-dive into project "${p}": ${ctx(keys.filter(k => k !== "project_dir"))}. Read recent sessions and summarize: what's the main work being done, what are the friction points, and what could be improved?`;
  }

  // Repeating tasks
  if (row.prompt_prefix !== undefined && row.times_asked !== undefined) {
    return `This task has been repeated ${row.times_asked}x in "${p}": "${row.prompt_prefix}". ${ctx(["avg_user_msgs", "avg_tool_calls", "avg_duration_min"])}. Create a reusable slash command or CLAUDE.md instruction so this runs automatically with zero back-and-forth next time.`;
  }

  // Hour/time bucket rows
  if (row.hour !== undefined) {
    const h = row.hour as number;
    return `Show me what I typically work on at ${h}:00. List the last 10 sessions started between ${h}:00-${h}:59 with their projects, first prompts, and outcomes. ${ctx(keys.filter(k => k !== "hour"))}`;
  }

  // Week rows
  if (row.week !== undefined) {
    return `Break down week ${row.week}: ${ctx(keys.filter(k => k !== "week"))}. Which projects dominated? Any notable sessions? Show the top 5 sessions by output tokens for this week.`;
  }

  // Duration/depth buckets
  if (row.duration_bucket !== undefined || row.depth_bucket !== undefined) {
    const bucket = (row.duration_bucket ?? row.depth_bucket) as string;
    return `Show me examples of "${bucket}" sessions. List 5 recent sessions in this bucket with their projects, first prompts, and whether they were successful. ${ctx(keys.filter(k => !k.includes("bucket")))}`;
  }

  // Model comparison rows
  if (model && row.sessions !== undefined && !proj && !sid) {
    return `Compare ${model} performance in detail: ${ctx(keys.filter(k => k !== "model"))}. Show 5 example sessions where this model excelled and 5 where it struggled. Which task types work best with this model?`;
  }

  // Tool-level rows (no project context)
  if (row.tool_name !== undefined && !proj) {
    return `Analyze my usage of "${row.tool_name}": ${ctx(keys.filter(k => k !== "tool_name"))}. Which projects use it most? Are there patterns of overuse or failed calls? Should I adjust my workflow?`;
  }

  // Subagent stats
  if (row.subagent_count !== undefined) {
    return `This session spawned ${row.subagent_count} subagents in "${p}". Read the parent session JSONL and explain: what tasks were parallelized, was it effective, and could the workflow be improved?${fp ? `\nFirst prompt: "${fp.slice(0, 120)}"` : ""}`;
  }

  // Fallback: if row has enough identifiable data, generate a generic explore prompt
  if (keys.length >= 3) {
    const summary = ctx(keys.slice(0, 6));
    if (summary.length > 20) {
      return `Explore this data point in depth: ${summary}. Give me concrete examples and actionable insights.`;
    }
  }

  return null;
}

function CopyPromptButton({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(prompt);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      title={prompt}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-500/10 text-violet-400 hover:bg-violet-500/20 transition-colors whitespace-nowrap"
    >
      {copied ? <Check className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
      {copied ? "copied" : "prompt"}
    </button>
  );
}

function ResultTable({ data, sectionTitle }: { data: Record<string, unknown>[]; sectionTitle?: string }) {
  if (!data || data.length === 0) return <p className="text-xs text-muted-foreground">No data</p>;
  const keys = Object.keys(data[0]);
  const hasGenPrompt = data.some((row) => genPromptForRow(row, sectionTitle) !== null);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted-foreground border-b border-border">
            {keys.map((k) => (
              <th key={k} className="text-left pb-2 pr-3 font-medium whitespace-nowrap">
                {k.replace(/_/g, " ")}
              </th>
            ))}
            {hasGenPrompt && (
              <th className="text-center pb-2 pr-3 font-medium whitespace-nowrap">action</th>
            )}
          </tr>
        </thead>
        <tbody>
          {data.slice(0, 30).map((row, i) => {
            const gp = hasGenPrompt ? genPromptForRow(row, sectionTitle) : null;
            return (
              <tr key={i} className="border-b border-border/30 last:border-0 hover:bg-muted/20">
                {keys.map((k) => {
                  let v = row[k];
                  let cls = "py-1.5 pr-3 ";
                  if (typeof v === "number") {
                    cls += "font-mono text-right ";
                    if (k.includes("token") || k === "avg_output" || k === "output_tokens") {
                      v = formatTokens(v as number);
                    } else if (k.includes("pct") || k.includes("reduction") || k.includes("ratio")) {
                      const s = `${v}%`;
                      cls += s.startsWith("-") ? "text-red-400 " : "text-green-400 ";
                      v = s;
                    } else if (k.includes("duration") || k.includes("seconds")) {
                      const n = v as number;
                      v = n > 3600 ? `${(n / 3600).toFixed(1)}h` : n > 60 ? `${(n / 60).toFixed(0)}m` : `${n}s`;
                    } else {
                      v = (v as number).toLocaleString();
                    }
                  }
                  if (k === "project_dir") { v = projName(v as string); cls += "max-w-[180px] truncate "; }
                  if (k === "first_prompt") { cls += "max-w-[250px] truncate text-muted-foreground "; v = (v as string)?.slice(0, 80) ?? "\u2014"; }
                  if (k === "session_id") { v = (v as string)?.slice(0, 12) ?? ""; cls += "font-mono "; }
                  return <td key={k} className={cls}>{String(v ?? "\u2014")}</td>;
                })}
                {hasGenPrompt && (
                  <td className="py-1.5 text-center">
                    {gp ? <CopyPromptButton prompt={gp} /> : null}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ResultRenderer({ data }: { data: unknown }) {
  if (Array.isArray(data)) return <ResultTable data={data as Record<string, unknown>[]} sectionTitle="results" />;

  if (data && typeof data === "object") {
    return (
      <div className="space-y-4">
        {Object.entries(data as Record<string, unknown>).map(([key, val]) => (
          <div key={key}>
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              {key.replace(/_/g, " ")}
            </h4>
            {Array.isArray(val) ? (
              <ResultTable data={val as Record<string, unknown>[]} sectionTitle={key} />
            ) : val && typeof val === "object" ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {Object.entries(val as Record<string, unknown>).map(([k, v]) => (
                  <div key={k} className="rounded border border-border/50 p-2">
                    <div className="text-[10px] text-muted-foreground uppercase">{k.replace(/_/g, " ")}</div>
                    <div className="text-sm font-bold">
                      {typeof v === "number" ? (k.includes("token") ? formatTokens(v) : v.toLocaleString()) : String(v ?? "\u2014")}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <span className="text-xs">{String(val)}</span>
            )}
          </div>
        ))}
      </div>
    );
  }

  return <pre className="text-xs overflow-auto">{JSON.stringify(data, null, 2)}</pre>;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function DeepAnalytics() {
  const [activeResult, setActiveResult] = useState<{ title: string; data: unknown } | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recentReports, setRecentReports] = useState<SavedReport[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState<ReportTemplate | null>(null);
  const [viewingReport, setViewingReport] = useState<SavedReport | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  // Generate mode: Claude Code session producing HTML report
  const [generating, setGenerating] = useState(false);
  const [genStatus, setGenStatus] = useState<string[]>([]);
  const [genReportHtml, setGenReportHtml] = useState<string | null>(null);
  const [genSessionId, setGenSessionId] = useState<string | null>(null);
  const [genPrompt, setGenPrompt] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [genFailed, setGenFailed] = useState(false);

  // Load recent reports
  useEffect(() => {
    fetch("/api/analytics/deep?action=history")
      .then((r) => r.json())
      .then((d) => setRecentReports(d.reports ?? []))
      .catch(() => {});
  }, []);

  const runQuery = useCallback(async (queryId: string, title: string) => {
    setLoading(queryId);
    setActiveResult(null);
    setError(null);
    setViewingReport(null);
    try {
      const res = await fetch("/api/analytics/deep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queryId }),
      });
      const data = await res.json();
      if (data.error) { setError(data.error); }
      else {
        setActiveResult({ title: data.title, data: data.data });
        setInputValue("");
        setSelectedTemplate(null);
        if (data.reportId) {
          setRecentReports((prev) => [
            { id: data.reportId, query_id: queryId, title: data.title, created_at: new Date().toISOString(), html: "" },
            ...prev.filter((r) => r.id !== data.reportId),
          ]);
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(null);
    }
  }, []);

  const generateReport = useCallback(async (question: string) => {
    setGenerating(true);
    setGenStatus(["Starting Claude Code session..."]);
    setGenReportHtml(null);
    setGenSessionId(null);
    setGenPrompt(null);
    setShowPrompt(false);
    setEditingPrompt(false);
    setGenFailed(false);
    setActiveResult(null);
    setError(null);

    try {
      const res = await fetch("/api/analytics/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No stream");

      const decoder = new TextDecoder();
      let buf = "";
      let gotHtml = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const lines = buf.split("\n");
        buf = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === "prompt") {
              setGenPrompt(evt.prompt);
            } else if (evt.type === "session_id") {
              setGenSessionId(evt.session_id);
              setGenStatus((s) => [...s, `Session: ${evt.session_id.slice(0, 12)}...`]);
            } else if (evt.type === "status") {
              setGenStatus((s) => [...s.slice(-4), evt.text]);
            } else if (evt.type === "text") {
              const snippet = evt.text.slice(0, 80).replace(/\n/g, " ");
              if (snippet.trim()) setGenStatus((s) => [...s.slice(-4), snippet]);
            } else if (evt.type === "report_done") {
              if (evt.htmlAvailable && evt.html) {
                setGenReportHtml(evt.html);
                setGenStatus((s) => [...s, "Report ready!"]);
                gotHtml = true;
              } else {
                setGenFailed(true);
              }
            } else if (evt.type === "error") {
              setGenStatus((s) => [...s, `Error: ${evt.text.slice(0, 100)}`]);
            }
          } catch { /* skip */ }
        }
      }
      if (!gotHtml) setGenFailed(true);
    } catch (e) {
      setError(String(e));
      setGenFailed(true);
    } finally {
      setGenerating(false);
      setInputValue("");
      setSelectedTemplate(null);
    }
  }, []);

  const submitInput = useCallback(() => {
    if (!inputValue.trim()) return;
    if (selectedTemplate) {
      // Preset template — run instant SQL query
      runQuery(selectedTemplate.id, selectedTemplate.title);
    } else {
      // Custom question — always generate via Claude Code session
      generateReport(inputValue.trim());
    }
  }, [inputValue, selectedTemplate, runQuery, generateReport]);

  const autoRunTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectTemplate = useCallback((t: ReportTemplate) => {
    setSelectedTemplate(t);
    setInputValue(t.prompt);
    // Auto-run after 800ms if user doesn't edit
    if (autoRunTimer.current) clearTimeout(autoRunTimer.current);
    autoRunTimer.current = setTimeout(() => {
      runQuery(t.id, t.title);
    }, 800);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [runQuery]);

  return (
    <div>
      {/* Header */}
      <p className="text-sm text-muted-foreground mb-5">
        Pick a template to fill the question, edit if needed, then send
      </p>

      {/* Preset cards — click inserts prompt into input */}
      <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-3">
        Report Templates
      </div>
      <div className="grid grid-cols-2 gap-2.5 mb-6">
        {REPORT_TEMPLATES.map((t) => {
          const isSelected = selectedTemplate?.id === t.id;
          return (
            <button
              key={t.id}
              onClick={() => selectTemplate(t)}
              className={`relative flex items-center gap-3 rounded-xl border p-3.5 text-left transition-all hover:border-foreground/20 hover:shadow-sm ${
                isSelected
                  ? "border-violet-500/50 bg-violet-500/5 ring-1 ring-violet-500/20"
                  : "border-border bg-card"
              }`}
            >
              <div className={`shrink-0 rounded-lg p-2 ${t.color}`}>
                {getIcon(t.icon)}
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">{t.title}</div>
                <div className="text-xs text-muted-foreground">{t.subtitle}</div>
              </div>
              <span className="absolute top-2.5 right-3 text-[9px] font-semibold text-green-500 bg-green-500/10 px-1.5 py-0.5 rounded">
                INSTANT
              </span>
            </button>
          );
        })}
      </div>

      {/* Question input — templates insert here */}
      <div className={`flex items-center gap-2 rounded-xl border px-4 py-3 mb-8 transition-colors ${
        selectedTemplate ? "border-violet-500/30 bg-violet-500/5" : "border-border bg-card"
      }`}>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />}
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value);
            if (selectedTemplate && e.target.value !== selectedTemplate.prompt) {
              // User is editing — cancel auto-run, switch to custom mode
              if (autoRunTimer.current) { clearTimeout(autoRunTimer.current); autoRunTimer.current = null; }
              setSelectedTemplate(null);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitInput();
          }}
          placeholder="Pick a template above or type your own question..."
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
        />
        {inputValue && (
          <button
            onClick={() => { setInputValue(""); setSelectedTemplate(null); }}
            className="shrink-0 p-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          onClick={submitInput}
          disabled={!inputValue.trim() || !!loading || generating}
          className="shrink-0 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:hover:bg-violet-600 p-2 text-white transition-colors"
        >
          <Search className="h-4 w-4" />
        </button>
      </div>

      {/* Generating report via Claude Code */}
      {generating && (
        <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-5 mb-8">
          <div className="flex items-center gap-3 mb-3">
            <Loader2 className="h-5 w-5 animate-spin text-violet-400" />
            <h3 className="text-sm font-semibold text-violet-300">Generating report...</h3>
            <div className="flex items-center gap-2 ml-auto">
              {genPrompt && (
                <button
                  onClick={() => setShowPrompt(!showPrompt)}
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Eye className="h-3 w-3" />
                  {showPrompt ? "Hide" : "Show"} prompt
                </button>
              )}
              {genSessionId && (
                <a
                  href={`/claude-sessions/${genSessionId}`}
                  target="_blank"
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
                >
                  <ExternalLink className="h-3 w-3" />
                  View session
                </a>
              )}
            </div>
          </div>
          {showPrompt && genPrompt && (
            <pre className="text-[10px] text-muted-foreground bg-black/30 rounded-lg p-3 mb-3 max-h-48 overflow-auto whitespace-pre-wrap font-mono leading-relaxed">
              {genPrompt}
            </pre>
          )}
          <div className="space-y-1">
            {genStatus.slice(-5).map((s, i) => (
              <div key={i} className="text-xs text-muted-foreground font-mono truncate">
                {s}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Generation failed */}
      {genFailed && !generating && !genReportHtml && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-5 mb-8">
          <div className="flex items-center gap-3 mb-3">
            <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0" />
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-amber-300">Report not generated</h3>
              <p className="text-xs text-muted-foreground mt-1">
                Claude didn&apos;t produce the HTML report in one pass. You can continue the conversation in the session.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {genSessionId && (
              <a
                href={`/claude-sessions/${genSessionId}`}
                target="_blank"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-300 hover:text-amber-200 transition-colors"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open session to continue
              </a>
            )}
            <button
              onClick={() => { setGenFailed(false); setGenSessionId(null); setGenPrompt(null); }}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Dismiss
            </button>
          </div>
          {genPrompt && (
            <details className="mt-3">
              <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground">
                Show prompt sent to Claude
              </summary>
              <pre className="text-[10px] text-muted-foreground bg-black/30 rounded-lg p-3 mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono leading-relaxed">
                {genPrompt}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* Generated HTML report */}
      {genReportHtml && !generating && (
        <div className="rounded-xl border border-border bg-card mb-8 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-border">
            <h3 className="text-sm font-semibold">Generated Report</h3>
            <div className="flex items-center gap-3">
              {genPrompt && (
                <button
                  onClick={() => setShowPrompt(!showPrompt)}
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Eye className="h-3 w-3" />
                  prompt
                </button>
              )}
              {genSessionId && (
                <a
                  href={`/claude-sessions/${genSessionId}`}
                  target="_blank"
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
                >
                  <ExternalLink className="h-3 w-3" />
                  session
                </a>
              )}
              <button onClick={() => { setGenReportHtml(null); setGenPrompt(null); setShowPrompt(false); }} className="p-1 rounded hover:bg-muted/40">
                <X className="h-4 w-4 text-muted-foreground" />
              </button>
            </div>
          </div>
          {showPrompt && genPrompt && (
            <div className="px-5 py-3 border-b border-border bg-black/20">
              {editingPrompt ? (
                <textarea
                  defaultValue={genPrompt}
                  onChange={(e) => setGenPrompt(e.target.value)}
                  className="w-full text-[10px] font-mono bg-transparent text-muted-foreground outline-none resize-none leading-relaxed"
                  rows={12}
                />
              ) : (
                <pre className="text-[10px] text-muted-foreground max-h-48 overflow-auto whitespace-pre-wrap font-mono leading-relaxed">
                  {genPrompt}
                </pre>
              )}
              <div className="flex items-center gap-2 mt-2">
                <button
                  onClick={() => setEditingPrompt(!editingPrompt)}
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Pencil className="h-3 w-3" />
                  {editingPrompt ? "Done editing" : "Edit prompt"}
                </button>
                <button
                  onClick={() => { navigator.clipboard.writeText(genPrompt); }}
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Copy className="h-3 w-3" />
                  Copy
                </button>
              </div>
            </div>
          )}
          <iframe
            srcDoc={genReportHtml}
            className="w-full border-0"
            style={{ minHeight: 600 }}
            sandbox="allow-scripts"
            onLoad={(e) => {
              const iframe = e.target as HTMLIFrameElement;
              try {
                const h = iframe.contentDocument?.documentElement?.scrollHeight;
                if (h && h > 100) iframe.style.height = `${h + 20}px`;
              } catch { /* cross-origin */ }
            }}
          />
        </div>
      )}

      {/* Active result (instant presets) */}
      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 mb-6">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {activeResult && (
        <div className="rounded-xl border border-border bg-card p-5 mb-8">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold">{activeResult.title}</h3>
            <button onClick={() => setActiveResult(null)} className="p-1 rounded hover:bg-muted/40">
              <X className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>
          <ResultRenderer data={activeResult.data} />
        </div>
      )}

      {/* Viewing a saved report */}
      {viewingReport?.html && (
        <div className="rounded-xl border border-border bg-card p-5 mb-8">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold">{viewingReport.title}</h3>
            <button onClick={() => setViewingReport(null)} className="p-1 rounded hover:bg-muted/40">
              <X className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>
          <div dangerouslySetInnerHTML={{ __html: viewingReport.html }} className="text-xs" />
        </div>
      )}

      {/* Recent Reports */}
      {recentReports.length > 0 && (
        <div>
          <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-3">
            Recent Reports
          </div>
          <div className="space-y-2">
            {recentReports.slice(0, 10).map((r) => {
              const template = REPORT_TEMPLATES.find((t) => t.id === r.query_id);
              return (
                <button
                  key={r.id}
                  onClick={() => {
                    // If it has HTML results, show them; otherwise re-run
                    if (r.html) {
                      setViewingReport(r);
                      setActiveResult(null);
                    } else if (template) {
                      runQuery(template.id, template.title);
                    } else {
                      // Custom query with no cached HTML — re-run as generate
                      generateReport(r.title);
                    }
                  }}
                  className={`w-full flex items-center gap-3 rounded-xl border p-3 text-left transition-all group ${
                    (viewingReport?.id === r.id || activeResult?.title === r.title)
                      ? "border-foreground/30 bg-accent/50"
                      : "border-border bg-card hover:border-foreground/20"
                  }`}
                >
                  <div className={`shrink-0 rounded-lg p-2 ${template?.color ?? "text-muted-foreground bg-muted/20"}`}>
                    {template ? getIcon(template.icon) : <Search className="h-5 w-5" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{r.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {timeAgo(r.created_at)}
                      <span className="text-green-500 ml-2">instant</span>
                    </div>
                  </div>
                  <ChevronDown className="h-4 w-4 text-muted-foreground -rotate-90 group-hover:text-foreground transition-colors" />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
