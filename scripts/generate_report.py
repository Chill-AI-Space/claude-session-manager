#!/usr/bin/env python3
"""Generate HTML analytics report from the analytics SQLite DB."""
import sqlite3
import json
from pathlib import Path
from datetime import datetime

DB_PATH = Path(__file__).parent.parent / "data" / "analytics.db"
OUTPUT = Path(__file__).parent.parent / "session-analytics-report.html"


def query(conn, sql, params=()):
    return conn.execute(sql, params).fetchall()


def query_one(conn, sql, params=()):
    return conn.execute(sql, params).fetchone()


def generate_report():
    conn = sqlite3.connect(str(DB_PATH))

    # ── Gather all data ──
    total_sessions = query_one(conn, "SELECT COUNT(*) FROM sessions WHERE is_subagent=0")[0]
    total_subagents = query_one(conn, "SELECT COUNT(*) FROM sessions WHERE is_subagent=1")[0]
    total_messages = query_one(conn, "SELECT COUNT(*) FROM messages")[0]
    total_tools = query_one(conn, "SELECT COUNT(*) FROM tool_calls")[0]
    total_compacts = query_one(conn, "SELECT COUNT(*) FROM compacts")[0]

    tokens = query_one(conn, """
        SELECT SUM(total_input_tokens), SUM(total_output_tokens),
               SUM(total_cache_read_tokens), SUM(total_cache_creation_tokens)
        FROM sessions
    """)

    # Daily activity
    daily = query(conn, """
        SELECT date(started_at) as day, COUNT(*) as sessions,
               SUM(total_input_tokens + total_output_tokens) as tokens,
               SUM(compact_count) as compacts,
               SUM(tool_call_count) as tools
        FROM sessions WHERE is_subagent=0 AND started_at IS NOT NULL
        GROUP BY day ORDER BY day
    """)

    # Projects
    projects = query(conn, """
        SELECT project_dir, COUNT(*) as cnt,
               SUM(total_input_tokens) as inp, SUM(total_output_tokens) as outp,
               SUM(compact_count) as compacts, SUM(tool_call_count) as tools
        FROM sessions WHERE is_subagent=0
        GROUP BY project_dir ORDER BY cnt DESC LIMIT 20
    """)

    # Tools
    tools = query(conn, """
        SELECT tool_name, COUNT(*) as cnt, COUNT(DISTINCT session_id) as sessions,
               CASE WHEN tool_name LIKE 'mcp__%' THEN 1 ELSE 0 END as is_mcp
        FROM tool_calls GROUP BY tool_name ORDER BY cnt DESC LIMIT 25
    """)

    # Models
    models = query(conn, """
        SELECT model, COUNT(*) as cnt FROM sessions WHERE model IS NOT NULL
        GROUP BY model ORDER BY cnt DESC
    """)

    # Duration distribution
    durations = query(conn, """
        SELECT
            CASE
                WHEN duration_seconds < 60 THEN '< 1 min'
                WHEN duration_seconds < 300 THEN '1-5 min'
                WHEN duration_seconds < 900 THEN '5-15 min'
                WHEN duration_seconds < 1800 THEN '15-30 min'
                WHEN duration_seconds < 3600 THEN '30-60 min'
                WHEN duration_seconds < 7200 THEN '1-2 hr'
                WHEN duration_seconds < 14400 THEN '2-4 hr'
                ELSE '4+ hr'
            END as bucket,
            COUNT(*) as cnt,
            MIN(duration_seconds) as min_d
        FROM sessions WHERE is_subagent=0 AND duration_seconds IS NOT NULL
        GROUP BY bucket ORDER BY min_d
    """)

    # Compact analysis
    compact_stats = query_one(conn, """
        SELECT COUNT(*), AVG(pre_input_tokens), AVG(post_input_tokens),
               AVG(summary_length), AVG(messages_before),
               AVG(CASE WHEN pre_input_tokens > 0 THEN (pre_input_tokens - post_input_tokens) * 100.0 / pre_input_tokens END)
        FROM compacts WHERE pre_input_tokens > 1000 AND post_input_tokens > 1000
    """)

    compact_detail = query(conn, """
        SELECT c.timestamp, s.project_dir, c.pre_input_tokens, c.post_input_tokens,
               c.summary_length, c.messages_before, s.model
        FROM compacts c JOIN sessions s ON s.session_id = c.session_id
        WHERE c.pre_input_tokens > 1000 AND c.post_input_tokens > 1000
        ORDER BY c.timestamp DESC LIMIT 30
    """)

    # MCP servers
    mcp = query(conn, """
        SELECT mcp_server, COUNT(*) as calls, COUNT(DISTINCT session_id) as sessions
        FROM tool_calls WHERE is_mcp=1 AND mcp_server IS NOT NULL
        GROUP BY mcp_server ORDER BY calls DESC
    """)

    # Sessions with most compacts
    heavy_compact = query(conn, """
        SELECT s.session_id, s.project_dir, s.compact_count, s.message_count,
               s.duration_seconds, s.model, s.first_prompt
        FROM sessions s WHERE s.compact_count > 2 AND s.is_subagent=0
        ORDER BY s.compact_count DESC LIMIT 15
    """)

    conn.close()

    # ── Build HTML ──
    def fmt(n):
        if n is None:
            return "0"
        if n >= 1_000_000:
            return f"{n/1e6:.1f}M"
        if n >= 1_000:
            return f"{n/1e3:.1f}K"
        return str(int(n))

    def proj_name(p):
        if "GitHub-" in p:
            return p.split("GitHub-")[-1]
        return p.replace("-Users-vova-", "~/").replace("-", "/")

    def pct(pre, post):
        if pre and post and pre > 0:
            return f"{(pre - post) / pre * 100:.0f}%"
        return "-"

    # Chart data
    daily_labels = json.dumps([d[0] for d in daily[-30:]])
    daily_sessions = json.dumps([d[1] for d in daily[-30:]])
    daily_tokens = json.dumps([round(d[2] / 1e6, 2) if d[2] else 0 for d in daily[-30:]])
    daily_compacts = json.dumps([d[3] or 0 for d in daily[-30:]])

    duration_labels = json.dumps([d[0] for d in durations])
    duration_values = json.dumps([d[1] for d in durations])

    tool_labels = json.dumps([t[0][:30] for t in tools[:15]])
    tool_values = json.dumps([t[1] for t in tools[:15]])

    model_labels = json.dumps([m[0] for m in models])
    model_values = json.dumps([m[1] for m in models])

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Code Session Analytics</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<style>
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f13; color: #e4e4e7; line-height: 1.5; }}
.container {{ max-width: 1400px; margin: 0 auto; padding: 24px; }}
h1 {{ font-size: 28px; font-weight: 700; margin-bottom: 8px; background: linear-gradient(135deg, #a78bfa, #818cf8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }}
.subtitle {{ color: #71717a; margin-bottom: 32px; }}
.grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 32px; }}
.card {{ background: #18181b; border: 1px solid #27272a; border-radius: 12px; padding: 20px; }}
.card-label {{ font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #71717a; margin-bottom: 4px; }}
.card-value {{ font-size: 28px; font-weight: 700; color: #fafafa; }}
.card-sub {{ font-size: 12px; color: #52525b; margin-top: 2px; }}
.section {{ margin-bottom: 40px; }}
.section h2 {{ font-size: 20px; font-weight: 600; margin-bottom: 16px; color: #a1a1aa; }}
.chart-container {{ background: #18181b; border: 1px solid #27272a; border-radius: 12px; padding: 20px; margin-bottom: 20px; }}
.chart-row {{ display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }}
@media (max-width: 900px) {{ .chart-row {{ grid-template-columns: 1fr; }} }}
table {{ width: 100%; border-collapse: collapse; font-size: 14px; }}
th {{ text-align: left; padding: 10px 12px; color: #71717a; font-weight: 500; border-bottom: 1px solid #27272a; font-size: 12px; text-transform: uppercase; }}
td {{ padding: 8px 12px; border-bottom: 1px solid #1e1e22; }}
tr:hover td {{ background: #1c1c20; }}
.mono {{ font-family: 'SF Mono', Menlo, monospace; font-size: 13px; }}
.tag {{ display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 500; }}
.tag-green {{ background: #052e16; color: #4ade80; }}
.tag-blue {{ background: #172554; color: #60a5fa; }}
.tag-purple {{ background: #2e1065; color: #c084fc; }}
.tag-amber {{ background: #451a03; color: #fbbf24; }}
.bar {{ height: 6px; background: #27272a; border-radius: 3px; overflow: hidden; }}
.bar-fill {{ height: 100%; border-radius: 3px; background: linear-gradient(90deg, #818cf8, #a78bfa); }}
.prompt {{ max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #71717a; font-size: 12px; }}
</style>
</head>
<body>
<div class="container">
<h1>Claude Code Session Analytics</h1>
<p class="subtitle">Generated {datetime.now().strftime("%Y-%m-%d %H:%M")} | Data from ~/.claude/projects/</p>

<!-- KPI Cards -->
<div class="grid">
  <div class="card">
    <div class="card-label">Sessions</div>
    <div class="card-value">{total_sessions}</div>
    <div class="card-sub">+ {total_subagents} subagents</div>
  </div>
  <div class="card">
    <div class="card-label">Messages</div>
    <div class="card-value">{fmt(total_messages)}</div>
  </div>
  <div class="card">
    <div class="card-label">Tool Calls</div>
    <div class="card-value">{fmt(total_tools)}</div>
  </div>
  <div class="card">
    <div class="card-label">Auto-Compacts</div>
    <div class="card-value">{total_compacts}</div>
    <div class="card-sub">in {compact_stats[0] if compact_stats[0] else 0} valid events</div>
  </div>
  <div class="card">
    <div class="card-label">Cache Read</div>
    <div class="card-value">{fmt(tokens[2])}</div>
    <div class="card-sub">tokens total</div>
  </div>
  <div class="card">
    <div class="card-label">Output Tokens</div>
    <div class="card-value">{fmt(tokens[1])}</div>
  </div>
</div>

<!-- Daily Activity Chart -->
<div class="section">
  <h2>Daily Activity (Last 30 Days)</h2>
  <div class="chart-container">
    <canvas id="dailyChart" height="80"></canvas>
  </div>
</div>

<!-- Charts Row -->
<div class="chart-row">
  <div class="chart-container">
    <h2 style="margin-bottom:12px; font-size:16px; color:#a1a1aa;">Session Duration Distribution</h2>
    <canvas id="durationChart" height="120"></canvas>
  </div>
  <div class="chart-container">
    <h2 style="margin-bottom:12px; font-size:16px; color:#a1a1aa;">Models Used</h2>
    <canvas id="modelChart" height="120"></canvas>
  </div>
</div>

<div class="chart-row">
  <div class="chart-container">
    <h2 style="margin-bottom:12px; font-size:16px; color:#a1a1aa;">Top 15 Tools</h2>
    <canvas id="toolChart" height="160"></canvas>
  </div>
  <div class="chart-container">
    <h2 style="margin-bottom:12px; font-size:16px; color:#a1a1aa;">Compact Context Reduction</h2>
    <canvas id="compactChart" height="160"></canvas>
  </div>
</div>

<!-- Projects Table -->
<div class="section">
  <h2>Projects ({len(projects)})</h2>
  <div class="card">
  <table>
    <tr><th>Project</th><th>Sessions</th><th>Input Tokens</th><th>Output Tokens</th><th>Tools</th><th>Compacts</th><th></th></tr>
    {"".join(f'''<tr>
      <td class="mono">{proj_name(p[0])}</td>
      <td>{p[1]}</td>
      <td>{fmt(p[2])}</td>
      <td>{fmt(p[3])}</td>
      <td>{fmt(p[5])}</td>
      <td>{p[4]}</td>
      <td><div class="bar" style="width:120px"><div class="bar-fill" style="width:{min(p[1]/projects[0][1]*100,100):.0f}%"></div></div></td>
    </tr>''' for p in projects)}
  </table>
  </div>
</div>

<!-- Tools Table -->
<div class="section">
  <h2>Tool Usage</h2>
  <div class="card">
  <table>
    <tr><th>Tool</th><th>Calls</th><th>Sessions</th><th>Type</th></tr>
    {"".join(f'''<tr>
      <td class="mono">{t[0]}</td>
      <td>{t[1]:,d}</td>
      <td>{t[2]}</td>
      <td><span class="tag {'tag-purple' if t[3] else 'tag-blue'}">{'MCP' if t[3] else 'Built-in'}</span></td>
    </tr>''' for t in tools)}
  </table>
  </div>
</div>

<!-- MCP Servers -->
<div class="section">
  <h2>MCP Servers</h2>
  <div class="card">
  <table>
    <tr><th>Server</th><th>Calls</th><th>Sessions</th></tr>
    {"".join(f'<tr><td class="mono">{m[0]}</td><td>{m[1]:,d}</td><td>{m[2]}</td></tr>' for m in mcp)}
  </table>
  </div>
</div>

<!-- Compact Analysis -->
<div class="section">
  <h2>Auto-Compact Analysis</h2>
  <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));">
    <div class="card">
      <div class="card-label">Avg Pre-Compact</div>
      <div class="card-value">{fmt(compact_stats[1]) if compact_stats[1] else '-'}</div>
      <div class="card-sub">tokens</div>
    </div>
    <div class="card">
      <div class="card-label">Avg Post-Compact</div>
      <div class="card-value">{fmt(compact_stats[2]) if compact_stats[2] else '-'}</div>
      <div class="card-sub">tokens</div>
    </div>
    <div class="card">
      <div class="card-label">Avg Reduction</div>
      <div class="card-value">{compact_stats[5]:.0f}%</div>
    </div>
    <div class="card">
      <div class="card-label">Avg Summary</div>
      <div class="card-value">{fmt(compact_stats[3])}</div>
      <div class="card-sub">chars</div>
    </div>
    <div class="card">
      <div class="card-label">Avg Msgs Before</div>
      <div class="card-value">{compact_stats[4]:.0f}</div>
    </div>
  </div>

  <div class="card" style="margin-top:16px;">
  <table>
    <tr><th>Time</th><th>Project</th><th>Pre-Tokens</th><th>Post-Tokens</th><th>Reduction</th><th>Summary</th><th>Msgs</th></tr>
    {"".join(f'''<tr>
      <td class="mono">{c[0][:16] if c[0] else '-'}</td>
      <td class="mono">{proj_name(c[1])}</td>
      <td>{c[2]:,d}</td>
      <td>{c[3]:,d}</td>
      <td><span class="tag tag-green">{pct(c[2],c[3])}</span></td>
      <td>{fmt(c[4])} ch</td>
      <td>{c[5]}</td>
    </tr>''' for c in compact_detail)}
  </table>
  </div>
</div>

<!-- Heavy Compact Sessions -->
<div class="section">
  <h2>Sessions with Most Compacts</h2>
  <div class="card">
  <table>
    <tr><th>Session</th><th>Project</th><th>Compacts</th><th>Messages</th><th>Duration</th><th>Model</th><th>First Prompt</th></tr>
    {"".join(f'''<tr>
      <td class="mono">{h[0][:12]}</td>
      <td class="mono">{proj_name(h[1])}</td>
      <td><span class="tag tag-amber">{h[2]}</span></td>
      <td>{h[3]}</td>
      <td>{f"{h[4]/3600:.1f}h" if h[4] else '-'}</td>
      <td class="mono">{(h[5] or '-').replace('claude-','')[:15]}</td>
      <td class="prompt">{(h[6] or '-')[:80]}</td>
    </tr>''' for h in heavy_compact)}
  </table>
  </div>
</div>

</div>

<script>
Chart.defaults.color = '#71717a';
Chart.defaults.borderColor = '#27272a';
const gridColor = '#1e1e22';

// Daily Activity
new Chart(document.getElementById('dailyChart'), {{
  type: 'bar',
  data: {{
    labels: {daily_labels},
    datasets: [
      {{ label: 'Sessions', data: {daily_sessions}, backgroundColor: '#818cf8', yAxisID: 'y', borderRadius: 3 }},
      {{ label: 'Tokens (M)', data: {daily_tokens}, type: 'line', borderColor: '#f472b6', yAxisID: 'y1', tension: 0.3, pointRadius: 2 }},
      {{ label: 'Compacts', data: {daily_compacts}, type: 'line', borderColor: '#4ade80', yAxisID: 'y1', tension: 0.3, pointRadius: 2 }}
    ]
  }},
  options: {{
    responsive: true,
    scales: {{
      y: {{ position: 'left', grid: {{ color: gridColor }} }},
      y1: {{ position: 'right', grid: {{ display: false }} }},
      x: {{ grid: {{ display: false }}, ticks: {{ maxTicksLimit: 15 }} }}
    }}
  }}
}});

// Duration
new Chart(document.getElementById('durationChart'), {{
  type: 'doughnut',
  data: {{
    labels: {duration_labels},
    datasets: [{{ data: {duration_values}, backgroundColor: ['#818cf8','#a78bfa','#c084fc','#e879f9','#f472b6','#fb7185','#fbbf24','#4ade80'] }}]
  }},
  options: {{ responsive: true, plugins: {{ legend: {{ position: 'right', labels: {{ font: {{ size: 11 }} }} }} }} }}
}});

// Models
new Chart(document.getElementById('modelChart'), {{
  type: 'doughnut',
  data: {{
    labels: {model_labels},
    datasets: [{{ data: {model_values}, backgroundColor: ['#818cf8','#4ade80','#fbbf24','#f472b6','#60a5fa','#c084fc'] }}]
  }},
  options: {{ responsive: true, plugins: {{ legend: {{ position: 'right', labels: {{ font: {{ size: 11 }} }} }} }} }}
}});

// Tools
new Chart(document.getElementById('toolChart'), {{
  type: 'bar',
  data: {{
    labels: {tool_labels},
    datasets: [{{ data: {tool_values}, backgroundColor: '#818cf8', borderRadius: 3 }}]
  }},
  options: {{ responsive: true, indexAxis: 'y', plugins: {{ legend: {{ display: false }} }}, scales: {{ x: {{ grid: {{ color: gridColor }} }} }} }}
}});

// Compact reduction scatter
const compactData = {json.dumps([{"x": c[2], "y": c[3], "label": proj_name(c[1])} for c in compact_detail])};
new Chart(document.getElementById('compactChart'), {{
  type: 'scatter',
  data: {{
    datasets: [{{
      data: compactData.map(d => ({{ x: d.x, y: d.y }})),
      backgroundColor: '#4ade80',
      pointRadius: 5,
    }}]
  }},
  options: {{
    responsive: true,
    plugins: {{ legend: {{ display: false }} }},
    scales: {{
      x: {{ title: {{ display: true, text: 'Pre-Compact Tokens' }}, grid: {{ color: gridColor }} }},
      y: {{ title: {{ display: true, text: 'Post-Compact Tokens' }}, grid: {{ color: gridColor }} }}
    }}
  }}
}});
</script>
</body>
</html>"""

    OUTPUT.write_text(html)
    print(f"Report generated: {OUTPUT}")
    print(f"Size: {OUTPUT.stat().st_size / 1024:.0f} KB")
    return str(OUTPUT)


if __name__ == "__main__":
    generate_report()
