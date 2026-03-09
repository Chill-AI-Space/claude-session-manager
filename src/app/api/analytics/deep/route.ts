import { NextRequest, NextResponse } from "next/server";
import { getAnalyticsDb, saveReport, getRecentReports } from "@/lib/analytics-db";

export const dynamic = "force-dynamic";

interface PresetQuery {
  id: string;
  category: string;
  title: string;
  description: string;
  run: (db: ReturnType<typeof getAnalyticsDb>, params?: Record<string, string>) => unknown;
}

const PRESET_QUERIES: PresetQuery[] = [
  // ── TIME & PROCESS ──
  {
    id: "claude-thinking-time",
    category: "Time & Process",
    title: "Claude thinking time by session length",
    description: "How long does Claude spend thinking vs producing output, segmented by session duration",
    run: (db) => {
      return db.prepare(`
        SELECT
          CASE
            WHEN s.duration_seconds < 300 THEN '< 5 min'
            WHEN s.duration_seconds < 1800 THEN '5-30 min'
            WHEN s.duration_seconds < 3600 THEN '30-60 min'
            WHEN s.duration_seconds < 14400 THEN '1-4 hr'
            ELSE '4+ hr'
          END as duration_bucket,
          COUNT(DISTINCT s.session_id) as sessions,
          ROUND(AVG(s.total_output_tokens), 0) as avg_output_tokens,
          ROUND(AVG(s.total_thinking_tokens), 0) as avg_thinking_chars,
          ROUND(AVG(s.tool_call_count), 1) as avg_tool_calls,
          ROUND(AVG(s.message_count), 0) as avg_messages,
          ROUND(AVG(s.compact_count), 1) as avg_compacts
        FROM sessions s
        WHERE s.is_subagent = 0 AND s.duration_seconds IS NOT NULL AND s.duration_seconds > 0
        GROUP BY duration_bucket
        ORDER BY MIN(s.duration_seconds)
      `).all();
    },
  },
  {
    id: "user-response-time",
    category: "Time & Process",
    title: "Your response time to Claude",
    description: "How quickly you reply after Claude finishes — by hour of day and project",
    run: (db) => {
      const byHour = db.prepare(`
        SELECT
          CAST(strftime('%H', m1.timestamp) AS INTEGER) as hour,
          COUNT(*) as count,
          ROUND(AVG(
            (julianday(m2.timestamp) - julianday(m1.timestamp)) * 86400
          ), 1) as avg_response_seconds
        FROM messages m1
        JOIN messages m2 ON m2.session_id = m1.session_id
          AND m2.type = 'user'
          AND m2.line_number = (
            SELECT MIN(line_number) FROM messages
            WHERE session_id = m1.session_id AND line_number > m1.line_number AND type = 'user'
          )
        WHERE m1.type = 'assistant' AND m1.stop_reason = 'end_turn'
          AND m1.timestamp IS NOT NULL AND m2.timestamp IS NOT NULL
          AND (julianday(m2.timestamp) - julianday(m1.timestamp)) * 86400 BETWEEN 2 AND 3600
        GROUP BY hour ORDER BY hour
      `).all();

      const byProject = db.prepare(`
        SELECT
          s.project_dir,
          COUNT(*) as exchanges,
          ROUND(AVG(
            (julianday(m2.timestamp) - julianday(m1.timestamp)) * 86400
          ), 1) as avg_response_seconds
        FROM messages m1
        JOIN messages m2 ON m2.session_id = m1.session_id
          AND m2.type = 'user'
          AND m2.line_number = (
            SELECT MIN(line_number) FROM messages
            WHERE session_id = m1.session_id AND line_number > m1.line_number AND type = 'user'
          )
        JOIN sessions s ON s.session_id = m1.session_id AND s.is_subagent = 0
        WHERE m1.type = 'assistant' AND m1.stop_reason = 'end_turn'
          AND m1.timestamp IS NOT NULL AND m2.timestamp IS NOT NULL
          AND (julianday(m2.timestamp) - julianday(m1.timestamp)) * 86400 BETWEEN 2 AND 3600
        GROUP BY s.project_dir
        HAVING exchanges >= 5
        ORDER BY avg_response_seconds ASC
        LIMIT 15
      `).all();

      return { byHour, byProject };
    },
  },
  {
    id: "claude-turn-duration",
    category: "Time & Process",
    title: "Claude's turn duration (thinking + tool use)",
    description: "How long Claude takes per turn, split by whether it used tools",
    run: (db) => {
      return db.prepare(`
        SELECT
          CASE WHEN m.has_tool_use = 1 THEN 'With tools' ELSE 'Text only' END as turn_type,
          CASE WHEN m.has_thinking = 1 THEN 'With thinking' ELSE 'No thinking' END as thinking,
          COUNT(*) as turns,
          ROUND(AVG(m.output_tokens), 0) as avg_output_tokens,
          ROUND(AVG(m.content_length), 0) as avg_content_chars
        FROM messages m
        WHERE m.type = 'assistant' AND m.output_tokens > 0
        GROUP BY turn_type, thinking
        ORDER BY turns DESC
      `).all();
    },
  },
  {
    id: "productivity-by-hour",
    category: "Time & Process",
    title: "Productivity by hour of day",
    description: "When are you most active with Claude — sessions, messages, and tool calls by hour",
    run: (db) => {
      return db.prepare(`
        SELECT
          CAST(strftime('%H', started_at) AS INTEGER) as hour,
          COUNT(*) as sessions,
          SUM(message_count) as messages,
          SUM(tool_call_count) as tool_calls,
          SUM(total_output_tokens) as output_tokens
        FROM sessions
        WHERE is_subagent = 0 AND started_at IS NOT NULL
        GROUP BY hour ORDER BY hour
      `).all();
    },
  },

  // ── FRICTION & CORRECTIONS ──
  {
    id: "high-correction-sessions",
    category: "Friction & Corrections",
    title: "Sessions with most back-and-forth corrections",
    description: "Sessions with high user-to-assistant message ratio — likely correction-heavy",
    run: (db) => {
      return db.prepare(`
        SELECT
          s.session_id,
          s.project_dir,
          s.first_prompt,
          s.model,
          s.user_message_count,
          s.assistant_message_count,
          ROUND(CAST(s.user_message_count AS REAL) / NULLIF(s.assistant_message_count, 0), 2) as user_to_assistant_ratio,
          s.compact_count,
          s.duration_seconds,
          s.total_output_tokens
        FROM sessions s
        WHERE s.is_subagent = 0 AND s.user_message_count > 10
          AND s.assistant_message_count > 5
        ORDER BY user_to_assistant_ratio DESC
        LIMIT 20
      `).all();
    },
  },
  {
    id: "compact-context-loss",
    category: "Friction & Corrections",
    title: "Context loss from auto-compacts",
    description: "Sessions where compaction happened — potential context loss points with pre/post token sizes",
    run: (db) => {
      return db.prepare(`
        SELECT
          c.session_id,
          s.project_dir,
          s.first_prompt,
          c.timestamp,
          c.pre_input_tokens,
          c.post_input_tokens,
          ROUND((c.pre_input_tokens - c.post_input_tokens) * 100.0 / NULLIF(c.pre_input_tokens, 0), 1) as reduction_pct,
          c.summary_length,
          c.messages_before,
          s.compact_count as total_compacts_in_session,
          s.model
        FROM compacts c
        JOIN sessions s ON s.session_id = c.session_id
        WHERE c.pre_input_tokens > 1000
        ORDER BY c.timestamp DESC
        LIMIT 30
      `).all();
    },
  },
  {
    id: "tool-failure-patterns",
    category: "Friction & Corrections",
    title: "Tool usage patterns — heavy retry sessions",
    description: "Sessions with high tool call counts per message — may indicate struggles",
    run: (db) => {
      return db.prepare(`
        SELECT
          s.session_id,
          s.project_dir,
          s.first_prompt,
          s.tool_call_count,
          s.message_count,
          ROUND(CAST(s.tool_call_count AS REAL) / NULLIF(s.message_count, 0), 1) as tools_per_message,
          s.model,
          s.duration_seconds,
          s.compact_count
        FROM sessions s
        WHERE s.is_subagent = 0 AND s.tool_call_count > 20 AND s.message_count > 10
        ORDER BY tools_per_message DESC
        LIMIT 20
      `).all();
    },
  },
  {
    id: "sidechain-corrections",
    category: "Friction & Corrections",
    title: "Sidechain (undo/retry) frequency",
    description: "How often sidechains are used — indicates user corrected Claude's approach",
    run: (db) => {
      const perProject = db.prepare(`
        SELECT
          s.project_dir,
          COUNT(DISTINCT s.session_id) as sessions,
          SUM(CASE WHEN m.is_sidechain = 1 THEN 1 ELSE 0 END) as sidechain_messages,
          SUM(CASE WHEN m.is_sidechain = 0 THEN 1 ELSE 0 END) as main_messages,
          ROUND(SUM(CASE WHEN m.is_sidechain = 1 THEN 1 ELSE 0 END) * 100.0 /
                NULLIF(COUNT(*), 0), 1) as sidechain_pct
        FROM messages m
        JOIN sessions s ON s.session_id = m.session_id AND s.is_subagent = 0
        GROUP BY s.project_dir
        HAVING sessions >= 3
        ORDER BY sidechain_pct DESC
        LIMIT 15
      `).all();

      return { perProject };
    },
  },

  // ── COLLABORATION & PEOPLE ──
  {
    id: "collaboration-topics",
    category: "Collaboration & People",
    title: "Who you work with — mentions in sessions",
    description: "Names, teams, and companies mentioned across your sessions",
    run: (db) => {
      // Search for common collaboration patterns in first prompts
      const mentions = db.prepare(`
        SELECT
          s.project_dir,
          s.first_prompt,
          s.started_at,
          s.session_id
        FROM sessions s
        WHERE s.is_subagent = 0
          AND s.first_prompt IS NOT NULL
          AND (
            s.first_prompt LIKE '%@%'
            OR s.first_prompt LIKE '%report%'
            OR s.first_prompt LIKE '%client%'
            OR s.first_prompt LIKE '%team%'
            OR s.first_prompt LIKE '%colleague%'
            OR s.first_prompt LIKE '%send%'
            OR s.first_prompt LIKE '%share%'
            OR s.first_prompt LIKE '%для%'
            OR s.first_prompt LIKE '%клиент%'
            OR s.first_prompt LIKE '%коллег%'
            OR s.first_prompt LIKE '%отчет%'
            OR s.first_prompt LIKE '%репорт%'
          )
        ORDER BY s.started_at DESC
        LIMIT 50
      `).all();

      return { mentions };
    },
  },
  {
    id: "project-work-distribution",
    category: "Collaboration & People",
    title: "Project work distribution over time",
    description: "What projects you work on each week — shows focus shifts",
    run: (db) => {
      return db.prepare(`
        SELECT
          strftime('%Y-W%W', started_at) as week,
          project_dir,
          COUNT(*) as sessions,
          SUM(total_output_tokens) as output_tokens,
          SUM(tool_call_count) as tool_calls
        FROM sessions
        WHERE is_subagent = 0 AND started_at IS NOT NULL
          AND started_at >= date('now', '-60 days')
        GROUP BY week, project_dir
        HAVING sessions >= 2
        ORDER BY week DESC, sessions DESC
      `).all();
    },
  },
  {
    id: "report-generation",
    category: "Collaboration & People",
    title: "Report & deliverable generation sessions",
    description: "Sessions focused on creating reports, analyses, documents for others",
    run: (db) => {
      return db.prepare(`
        SELECT
          s.session_id, s.project_dir, s.first_prompt, s.started_at,
          s.total_output_tokens, s.duration_seconds, s.model
        FROM sessions s
        WHERE s.is_subagent = 0 AND s.first_prompt IS NOT NULL
          AND (
            s.first_prompt LIKE '%report%' OR s.first_prompt LIKE '%анализ%'
            OR s.first_prompt LIKE '%отчет%' OR s.first_prompt LIKE '%репорт%'
            OR s.first_prompt LIKE '%dashboard%' OR s.first_prompt LIKE '%дашборд%'
            OR s.first_prompt LIKE '%publish%' OR s.first_prompt LIKE '%опубликов%'
            OR s.first_prompt LIKE '%presentation%' OR s.first_prompt LIKE '%презентац%'
          )
        ORDER BY s.started_at DESC
        LIMIT 30
      `).all();
    },
  },

  // ── COST & EFFICIENCY ──
  {
    id: "token-waste-analysis",
    category: "Cost & Efficiency",
    title: "Token waste — sessions with high cache miss rate",
    description: "Sessions where cache wasn't utilized well, costing more tokens",
    run: (db) => {
      return db.prepare(`
        SELECT
          s.session_id, s.project_dir, s.first_prompt, s.model,
          s.total_input_tokens,
          s.total_cache_read_tokens,
          s.total_cache_creation_tokens,
          ROUND(s.total_cache_read_tokens * 100.0 /
                NULLIF(s.total_cache_read_tokens + s.total_cache_creation_tokens + s.total_input_tokens, 0), 1) as cache_hit_pct,
          s.total_output_tokens,
          s.duration_seconds
        FROM sessions s
        WHERE s.is_subagent = 0 AND s.total_input_tokens > 0
          AND (s.total_cache_read_tokens + s.total_cache_creation_tokens + s.total_input_tokens) > 10000
        ORDER BY cache_hit_pct ASC
        LIMIT 20
      `).all();
    },
  },
  {
    id: "model-efficiency",
    category: "Cost & Efficiency",
    title: "Model efficiency comparison",
    description: "Output per token and tool calls per session by model",
    run: (db) => {
      return db.prepare(`
        SELECT
          model,
          COUNT(*) as sessions,
          ROUND(AVG(total_output_tokens), 0) as avg_output,
          ROUND(AVG(tool_call_count), 1) as avg_tools,
          ROUND(AVG(message_count), 0) as avg_messages,
          ROUND(AVG(compact_count), 1) as avg_compacts,
          ROUND(AVG(duration_seconds), 0) as avg_duration_s,
          ROUND(AVG(CASE WHEN duration_seconds > 0 THEN total_output_tokens * 1.0 / duration_seconds END), 1) as tokens_per_second
        FROM sessions
        WHERE is_subagent = 0 AND model IS NOT NULL AND duration_seconds > 60
        GROUP BY model
        HAVING sessions >= 5
        ORDER BY sessions DESC
      `).all();
    },
  },
  {
    id: "tool-usage-efficiency",
    category: "Cost & Efficiency",
    title: "Tool usage breakdown — built-in vs MCP",
    description: "Which tools you use most, built-in vs MCP, and their distribution across projects",
    run: (db) => {
      const overall = db.prepare(`
        SELECT
          tool_name,
          COUNT(*) as calls,
          COUNT(DISTINCT session_id) as sessions,
          is_mcp,
          mcp_server
        FROM tool_calls
        GROUP BY tool_name
        ORDER BY calls DESC
        LIMIT 25
      `).all();

      const byProject = db.prepare(`
        SELECT
          s.project_dir,
          tc.tool_name,
          COUNT(*) as calls
        FROM tool_calls tc
        JOIN sessions s ON s.session_id = tc.session_id AND s.is_subagent = 0
        GROUP BY s.project_dir, tc.tool_name
        HAVING calls >= 10
        ORDER BY s.project_dir, calls DESC
      `).all();

      return { overall, byProject };
    },
  },

  // ── CONTEXT & PATTERNS ──
  {
    id: "compact-timing-analysis",
    category: "Context & Patterns",
    title: "Auto-compact timing and effectiveness",
    description: "When compacts happen, how much context is preserved, and reduction rates",
    run: (db) => {
      const stats = db.prepare(`
        SELECT
          COUNT(*) as total_compacts,
          ROUND(AVG(pre_input_tokens), 0) as avg_pre_tokens,
          ROUND(AVG(post_input_tokens), 0) as avg_post_tokens,
          ROUND(AVG(CASE WHEN pre_input_tokens > 0 THEN (pre_input_tokens - post_input_tokens) * 100.0 / pre_input_tokens END), 1) as avg_reduction_pct,
          ROUND(AVG(summary_length), 0) as avg_summary_chars,
          ROUND(AVG(messages_before), 0) as avg_messages_before,
          MIN(pre_input_tokens) as min_pre,
          MAX(pre_input_tokens) as max_pre
        FROM compacts
        WHERE pre_input_tokens > 1000 AND post_input_tokens > 1000
      `).get();

      const byProject = db.prepare(`
        SELECT
          s.project_dir,
          COUNT(*) as compacts,
          ROUND(AVG(c.pre_input_tokens), 0) as avg_pre,
          ROUND(AVG(c.post_input_tokens), 0) as avg_post,
          ROUND(AVG(CASE WHEN c.pre_input_tokens > 0 THEN (c.pre_input_tokens - c.post_input_tokens) * 100.0 / c.pre_input_tokens END), 1) as avg_reduction_pct
        FROM compacts c
        JOIN sessions s ON s.session_id = c.session_id
        WHERE c.pre_input_tokens > 1000 AND c.post_input_tokens > 1000
        GROUP BY s.project_dir
        HAVING compacts >= 2
        ORDER BY compacts DESC
      `).all();

      const timeline = db.prepare(`
        SELECT
          date(c.timestamp) as day,
          COUNT(*) as compacts,
          ROUND(AVG(c.pre_input_tokens), 0) as avg_pre,
          ROUND(AVG(c.post_input_tokens), 0) as avg_post
        FROM compacts c
        WHERE c.pre_input_tokens > 1000 AND c.timestamp IS NOT NULL
        ORDER BY day DESC
        LIMIT 30
      `).all();

      return { stats, byProject, timeline };
    },
  },
  {
    id: "session-depth",
    category: "Context & Patterns",
    title: "Session depth analysis",
    description: "How deep your sessions go — messages, compacts, and whether longer sessions are productive",
    run: (db) => {
      return db.prepare(`
        SELECT
          CASE
            WHEN message_count < 10 THEN '1-9 msgs'
            WHEN message_count < 30 THEN '10-29 msgs'
            WHEN message_count < 100 THEN '30-99 msgs'
            WHEN message_count < 300 THEN '100-299 msgs'
            ELSE '300+ msgs'
          END as depth_bucket,
          COUNT(*) as sessions,
          ROUND(AVG(tool_call_count), 1) as avg_tools,
          ROUND(AVG(total_output_tokens), 0) as avg_output,
          ROUND(AVG(compact_count), 1) as avg_compacts,
          ROUND(AVG(duration_seconds / 60.0), 1) as avg_duration_min,
          SUM(compact_count) as total_compacts
        FROM sessions
        WHERE is_subagent = 0 AND message_count > 0
        GROUP BY depth_bucket
        ORDER BY MIN(message_count)
      `).all();
    },
  },
  {
    id: "subagent-usage",
    category: "Context & Patterns",
    title: "Subagent (parallel task) usage",
    description: "How often subagents are spawned and which types are used most",
    run: (db) => {
      const stats = db.prepare(`
        SELECT
          COUNT(*) as total_subagents,
          COUNT(DISTINCT parent_session_id) as parent_sessions,
          ROUND(AVG(message_count), 0) as avg_messages,
          ROUND(AVG(total_output_tokens), 0) as avg_output
        FROM sessions WHERE is_subagent = 1
      `).get();

      const topParents = db.prepare(`
        SELECT
          s.parent_session_id,
          ps.project_dir,
          ps.first_prompt,
          COUNT(*) as subagent_count
        FROM sessions s
        LEFT JOIN sessions ps ON ps.session_id = s.parent_session_id
        WHERE s.is_subagent = 1 AND s.parent_session_id IS NOT NULL
        GROUP BY s.parent_session_id
        ORDER BY subagent_count DESC
        LIMIT 15
      `).all();

      return { stats, topParents };
    },
  },

  // ── MISUNDERSTANDINGS & KNOWLEDGE ──
  {
    id: "repetitive-misunderstandings",
    category: "Misunderstandings & Knowledge",
    title: "Repetitive understanding mismatches",
    description: "Sessions where Claude repeatedly misunderstood — detected via high sidechain (undo) rate, many short corrections, and recurring patterns per project",
    run: (db) => {
      // Sessions with highest mismatch signals
      // Short user msgs (<100 chars) = likely corrections ("no", "wrong", "not that", "try again")
      // High user/assistant ratio = user keeps correcting
      // Many compacts = session dragged on too long struggling
      const worstSessions = db.prepare(`
        WITH session_signals AS (
          SELECT
            s.session_id,
            s.project_dir,
            s.first_prompt,
            s.model,
            s.message_count,
            s.user_message_count,
            s.assistant_message_count,
            s.started_at,
            s.duration_seconds,
            s.compact_count,
            s.tool_call_count,
            SUM(CASE WHEN m.type = 'user' AND m.content_length < 100 AND m.content_length > 0 THEN 1 ELSE 0 END) as short_corrections,
            SUM(CASE WHEN m.type = 'user' AND m.content_length BETWEEN 1 AND 30 THEN 1 ELSE 0 END) as very_short_msgs,
            ROUND(s.user_message_count * 1.0 / NULLIF(s.assistant_message_count, 0), 2) as correction_ratio
          FROM messages m
          JOIN sessions s ON s.session_id = m.session_id AND s.is_subagent = 0
          WHERE s.message_count > 10
          GROUP BY s.session_id
        )
        SELECT *,
          ROUND(short_corrections * 100.0 / NULLIF(user_message_count, 0), 1) as correction_pct
        FROM session_signals
        WHERE short_corrections >= 5 OR (very_short_msgs >= 3 AND correction_ratio > 0.8)
        ORDER BY short_corrections DESC
        LIMIT 25
      `).all();

      // Projects with recurring mismatch patterns
      const byProject = db.prepare(`
        WITH session_scores AS (
          SELECT
            s.session_id,
            s.project_dir,
            s.user_message_count,
            s.assistant_message_count,
            s.compact_count,
            SUM(CASE WHEN m.type = 'user' AND m.content_length < 100 AND m.content_length > 0 THEN 1 ELSE 0 END) as short_corrections
          FROM messages m
          JOIN sessions s ON s.session_id = m.session_id AND s.is_subagent = 0
          WHERE s.message_count > 5
          GROUP BY s.session_id
        )
        SELECT
          project_dir,
          COUNT(*) as sessions,
          SUM(short_corrections) as total_short_corrections,
          ROUND(AVG(short_corrections), 1) as avg_corrections_per_session,
          ROUND(AVG(user_message_count * 1.0 / NULLIF(assistant_message_count, 0)), 2) as avg_correction_ratio,
          ROUND(AVG(compact_count), 1) as avg_compacts,
          SUM(CASE WHEN short_corrections >= 3 THEN 1 ELSE 0 END) as problem_sessions
        FROM session_scores
        GROUP BY project_dir
        HAVING sessions >= 3 AND total_short_corrections > 10
        ORDER BY avg_corrections_per_session DESC
        LIMIT 15
      `).all();

      // Model comparison — which model gets corrected more
      const byModel = db.prepare(`
        SELECT
          s.model,
          COUNT(DISTINCT s.session_id) as sessions,
          SUM(CASE WHEN m.type = 'user' AND m.content_length < 100 AND m.content_length > 0 THEN 1 ELSE 0 END) as short_corrections,
          ROUND(SUM(CASE WHEN m.type = 'user' AND m.content_length < 100 AND m.content_length > 0 THEN 1 ELSE 0 END) * 1.0 / COUNT(DISTINCT s.session_id), 1) as corrections_per_session,
          ROUND(AVG(s.user_message_count * 1.0 / NULLIF(s.assistant_message_count, 0)), 2) as avg_correction_ratio
        FROM messages m
        JOIN sessions s ON s.session_id = m.session_id AND s.is_subagent = 0
        WHERE s.message_count > 5
        GROUP BY s.model
        HAVING sessions >= 5
        ORDER BY corrections_per_session DESC
      `).all();

      return { worstSessions, byProject, byModel };
    },
  },
  {
    id: "knowledge-to-save",
    category: "Misunderstandings & Knowledge",
    title: "Knowledge worth saving as rules",
    description: "Projects with consistently high correction rates across sessions — would benefit from CLAUDE.md rules, guides, or saved patterns",
    run: (db) => {
      // Projects where corrections are chronic (not just one bad session)
      const chronicProjects = db.prepare(`
        WITH session_scores AS (
          SELECT
            s.session_id,
            s.project_dir,
            s.model,
            SUM(CASE WHEN m.type = 'user' AND m.content_length < 100 AND m.content_length > 0 THEN 1 ELSE 0 END) as short_corrections,
            s.message_count,
            s.user_message_count,
            s.assistant_message_count,
            s.compact_count
          FROM messages m
          JOIN sessions s ON s.session_id = m.session_id AND s.is_subagent = 0
          WHERE s.message_count > 5
          GROUP BY s.session_id
        ),
        project_stats AS (
          SELECT
            project_dir,
            COUNT(*) as total_sessions,
            SUM(CASE WHEN short_corrections >= 3 OR (user_message_count * 1.0 / NULLIF(assistant_message_count, 0)) > 1.2 THEN 1 ELSE 0 END) as problem_sessions,
            ROUND(SUM(CASE WHEN short_corrections >= 3 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as problem_session_pct,
            SUM(short_corrections) as total_short_corrections,
            ROUND(AVG(short_corrections), 1) as avg_corrections_per_session,
            ROUND(AVG(compact_count), 1) as avg_compacts
          FROM session_scores
          GROUP BY project_dir
          HAVING total_sessions >= 3
        )
        SELECT *
        FROM project_stats
        WHERE problem_sessions >= 2
        ORDER BY problem_session_pct DESC
        LIMIT 15
      `).all();

      // Recurring first-prompt patterns — similar tasks asked repeatedly
      const repeatingTasks = db.prepare(`
        SELECT
          s.project_dir,
          SUBSTR(s.first_prompt, 1, 80) as prompt_prefix,
          COUNT(*) as times_asked,
          ROUND(AVG(s.user_message_count), 0) as avg_user_msgs,
          ROUND(AVG(s.tool_call_count), 0) as avg_tool_calls,
          ROUND(AVG(s.duration_seconds / 60.0), 1) as avg_duration_min,
          GROUP_CONCAT(DISTINCT s.model) as models_used
        FROM sessions s
        WHERE s.is_subagent = 0
          AND s.first_prompt IS NOT NULL
          AND length(s.first_prompt) > 20
          AND s.first_prompt NOT LIKE 'Generate a short descriptive title%'
        GROUP BY s.project_dir, SUBSTR(s.first_prompt, 1, 80)
        HAVING times_asked >= 2
        ORDER BY times_asked DESC
        LIMIT 20
      `).all();

      // Tools with high failure/retry signal — same tool called many times in one session
      const toolRetryPatterns = db.prepare(`
        SELECT
          s.project_dir,
          tc.tool_name,
          COUNT(*) as total_calls,
          COUNT(DISTINCT s.session_id) as sessions,
          ROUND(COUNT(*) * 1.0 / COUNT(DISTINCT s.session_id), 1) as calls_per_session,
          CASE WHEN tc.is_mcp = 1 THEN 'MCP: ' || COALESCE(tc.mcp_server, '?') ELSE 'Built-in' END as tool_type
        FROM tool_calls tc
        JOIN sessions s ON s.session_id = tc.session_id AND s.is_subagent = 0
        GROUP BY s.project_dir, tc.tool_name
        HAVING sessions >= 3 AND calls_per_session > 15
        ORDER BY calls_per_session DESC
        LIMIT 15
      `).all();

      return { chronicProjects, repeatingTasks, toolRetryPatterns };
    },
  },

  // ── WORKFLOW ──
  {
    id: "daily-workflow-pattern",
    category: "Workflow",
    title: "Your daily workflow pattern",
    description: "How your Claude usage flows through the day — session starts, tools used, models chosen",
    run: (db) => {
      return db.prepare(`
        SELECT
          CAST(strftime('%H', started_at) AS INTEGER) as hour,
          COUNT(*) as sessions,
          SUM(tool_call_count) as tool_calls,
          SUM(total_output_tokens) as output_tokens,
          GROUP_CONCAT(DISTINCT model) as models_used,
          ROUND(AVG(duration_seconds / 60.0), 1) as avg_session_min
        FROM sessions
        WHERE is_subagent = 0 AND started_at IS NOT NULL
        GROUP BY hour ORDER BY hour
      `).all();
    },
  },
  {
    id: "weekly-trends",
    category: "Workflow",
    title: "Weekly usage trends",
    description: "How your Claude usage evolves week over week",
    run: (db) => {
      return db.prepare(`
        SELECT
          strftime('%Y-W%W', started_at) as week,
          COUNT(*) as sessions,
          SUM(message_count) as messages,
          SUM(tool_call_count) as tool_calls,
          SUM(total_output_tokens) as output_tokens,
          SUM(compact_count) as compacts,
          COUNT(DISTINCT project_dir) as projects_touched
        FROM sessions
        WHERE is_subagent = 0 AND started_at IS NOT NULL
        GROUP BY week ORDER BY week DESC
        LIMIT 12
      `).all();
    },
  },
];

export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action");

  if (action === "history") {
    try {
      const reports = getRecentReports(20);
      return NextResponse.json({
        reports: reports.map((r) => ({
          id: String(r.id),
          query_id: r.query_id,
          title: r.title,
          created_at: r.created_at,
          html: "", // don't send full data in list
        })),
      });
    } catch {
      return NextResponse.json({ reports: [] });
    }
  }

  const presets = PRESET_QUERIES.map(({ id, category, title, description }) => ({
    id, category, title, description,
  }));
  return NextResponse.json({ presets });
}

// Keyword map for fuzzy matching custom questions to presets
const KEYWORD_MAP: Record<string, string[]> = {
  "productivity-by-hour": ["productivity", "productive", "hour", "time of day", "when", "active", "час", "продуктив", "когда"],
  "compact-timing-analysis": ["compact", "compaction", "context loss", "context size", "компакт", "контекст", "сжатие", "потер"],
  "high-correction-sessions": ["correction", "back-and-forth", "friction", "коррекц", "исправлен", "фрикш"],
  "collaboration-topics": ["collaborat", "people", "team", "client", "who", "коллег", "команд", "клиент", "кто"],
  "model-efficiency": ["model", "opus", "sonnet", "haiku", "efficiency", "compare", "модел", "эффективн", "сравн"],
  "weekly-trends": ["week", "trend", "over time", "growth", "недел", "тренд", "динамик"],
  "tool-usage-efficiency": ["tool", "mcp", "bash", "edit", "grep", "тул", "инструмент"],
  "user-response-time": ["response time", "reply", "speed", "fast", "slow", "скорость", "ответ", "быстр", "медлен"],
  "repetitive-misunderstandings": ["misunderstand", "confusion", "mismatch", "repeat", "wrong", "непоним", "ошибк", "путан", "повтор"],
  "knowledge-to-save": ["knowledge", "rules", "save", "claude.md", "guide", "знан", "правил", "сохран", "гайд"],
  "claude-thinking-time": ["thinking", "think time", "думает", "время claude", "тратит"],
  "claude-turn-duration": ["turn", "duration", "длительн", "ход"],
  "compact-context-loss": ["context loss", "lost context", "потер контекст"],
  "tool-failure-patterns": ["fail", "retry", "error", "ошибк", "повтор", "неудач"],
  "sidechain-corrections": ["sidechain", "undo", "откат", "отмен"],
  "token-waste-analysis": ["waste", "cache", "expensive", "cost", "token", "трат", "кэш", "дорог", "стоим", "токен"],
  "session-depth": ["depth", "long", "deep", "message count", "глубин", "длин", "долг"],
  "subagent-usage": ["subagent", "agent", "parallel", "субагент", "параллел"],
  "daily-workflow-pattern": ["workflow", "daily", "pattern", "ежедневн", "паттерн", "рабоч"],
  "project-work-distribution": ["project", "distribution", "focus", "проект", "распредел", "фокус"],
  "report-generation": ["report", "deliverable", "document", "отчет", "репорт", "документ"],
};

function findBestPreset(question: string): PresetQuery | null {
  const q = question.toLowerCase();
  let bestId = "";
  let bestScore = 0;

  for (const [id, keywords] of Object.entries(KEYWORD_MAP)) {
    let score = 0;
    for (const kw of keywords) {
      if (q.includes(kw)) score += kw.length; // longer keyword matches = higher score
    }
    if (score > bestScore) {
      bestScore = score;
      bestId = id;
    }
  }

  if (bestScore >= 3) {
    return PRESET_QUERIES.find((p) => p.id === bestId) ?? null;
  }
  return null;
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { queryId, params } = body as { queryId: string; params?: Record<string, string> };

  // Direct preset match
  let preset = PRESET_QUERIES.find((q) => q.id === queryId);

  // Custom question — fuzzy match to best preset
  if (!preset && queryId.startsWith("custom:")) {
    const question = queryId.slice(7);
    preset = findBestPreset(question) ?? undefined;
    if (!preset) {
      // No match — run all presets that seem relevant, or fall back to a summary
      return NextResponse.json({
        error: `No matching report found for your question. Try one of the templates, or use keywords like: compact, model, cost, tool, productivity, misunderstanding, knowledge.`,
      }, { status: 400 });
    }
  }

  if (!preset) {
    return NextResponse.json({ error: "Unknown query" }, { status: 400 });
  }

  try {
    const db = getAnalyticsDb();
    const result = preset.run(db, params);

    // Save to history
    let reportId: string | undefined;
    try {
      const id = saveReport(preset.id, preset.title, JSON.stringify(result));
      reportId = String(id);
    } catch { /* non-critical */ }

    return NextResponse.json({
      queryId: preset.id,
      title: preset.title,
      category: preset.category,
      description: preset.description,
      data: result,
      reportId,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
