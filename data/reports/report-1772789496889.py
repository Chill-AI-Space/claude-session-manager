#!/usr/bin/env python3
"""Find sessions where the user struggled to explain what Claude needs from them.
Heuristic: high ratio of user messages to tool calls, many short user messages,
low "productivity" (few tool calls per user message), especially in long sessions.
"""

import sqlite3
import json
from datetime import datetime

DB = "/Users/vova/Documents/GitHub/claude-session-manager/data/analytics.db"
OUT = "/Users/vova/Documents/GitHub/claude-session-manager/data/reports/report-1772789496889.html"

conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

# Find sessions with high "clarification effort":
# - Many user messages relative to tool calls
# - Multiple back-and-forth exchanges
# - Filter out tiny sessions (< 4 user messages)
# Score = user_message_count / (tool_call_count + 1) * log(user_message_count)
sessions = conn.execute("""
    SELECT
        session_id,
        CASE
            WHEN project_dir LIKE '%GitHub-%' THEN substr(project_dir, instr(project_dir, 'GitHub-') + 7)
            ELSE project_dir
        END as project,
        first_prompt,
        user_message_count,
        assistant_message_count,
        tool_call_count,
        message_count,
        duration_seconds,
        started_at,
        compact_count,
        CAST(user_message_count AS REAL) / (tool_call_count + 1) as clarification_ratio,
        CAST(user_message_count AS REAL) / (tool_call_count + 1) *
            (CASE WHEN user_message_count > 2 THEN log(user_message_count) ELSE 0.5 END) as effort_score
    FROM sessions
    WHERE is_subagent = 0
      AND user_message_count >= 4
      AND message_count >= 8
    ORDER BY effort_score DESC
    LIMIT 30
""").fetchall()

# For top sessions, get message-level detail to find "clarification clusters"
# (consecutive user messages with short assistant responses between them)
top_sessions = []
for s in sessions[:30]:
    msgs = conn.execute("""
        SELECT type, content_length, has_tool_use, stop_reason
        FROM messages
        WHERE session_id = ? AND type IN ('user', 'assistant') AND subtype IS NULL
        ORDER BY line_number
    """, (s['session_id'],)).fetchall()

    # Count "clarification exchanges": user msg followed by assistant msg WITHOUT tool use
    clarification_count = 0
    total_exchanges = 0
    for i in range(len(msgs) - 1):
        if msgs[i]['type'] == 'user' and msgs[i+1]['type'] == 'assistant':
            total_exchanges += 1
            if not msgs[i+1]['has_tool_use']:
                clarification_count += 1

    clarification_pct = (clarification_count / total_exchanges * 100) if total_exchanges > 0 else 0

    top_sessions.append({
        'session_id': s['session_id'],
        'project': s['project'],
        'first_prompt': (s['first_prompt'] or '')[:120],
        'user_msgs': s['user_message_count'],
        'assistant_msgs': s['assistant_message_count'],
        'tool_calls': s['tool_call_count'],
        'duration_min': round(s['duration_seconds'] / 60, 1) if s['duration_seconds'] else 0,
        'started_at': s['started_at'],
        'clarification_ratio': round(s['clarification_ratio'], 2),
        'effort_score': round(s['effort_score'], 2),
        'clarification_pct': round(clarification_pct),
        'clarification_count': clarification_count,
        'total_exchanges': total_exchanges,
        'compacts': s['compact_count'] or 0,
    })

# Sort by clarification_pct * effort_score combined
for s in top_sessions:
    s['combined_score'] = s['effort_score'] * (1 + s['clarification_pct'] / 100)

top_sessions.sort(key=lambda x: x['combined_score'], reverse=True)

# Stats for charts
# Distribution: how many sessions fall into effort score buckets
all_scores = conn.execute("""
    SELECT
        CAST(user_message_count AS REAL) / (tool_call_count + 1) *
            (CASE WHEN user_message_count > 2 THEN log(user_message_count) ELSE 0.5 END) as effort_score
    FROM sessions
    WHERE is_subagent = 0 AND user_message_count >= 2 AND message_count >= 4
    ORDER BY effort_score DESC
""").fetchall()

buckets = {'0-1': 0, '1-2': 0, '2-3': 0, '3-5': 0, '5-8': 0, '8-12': 0, '12+': 0}
for row in all_scores:
    sc = row[0]
    if sc < 1: buckets['0-1'] += 1
    elif sc < 2: buckets['1-2'] += 1
    elif sc < 3: buckets['2-3'] += 1
    elif sc < 5: buckets['3-5'] += 1
    elif sc < 8: buckets['5-8'] += 1
    elif sc < 12: buckets['8-12'] += 1
    else: buckets['12+'] += 1

# Project breakdown for top frustrating sessions
project_counts = {}
for s in top_sessions[:20]:
    p = s['project'] or 'unknown'
    project_counts[p] = project_counts.get(p, 0) + 1

conn.close()

# Build HTML
top20 = top_sessions[:20]
table_rows = ""
for i, s in enumerate(top20):
    date = s['started_at'][:10] if s['started_at'] else '?'
    prompt_escaped = s['first_prompt'].replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')
    bar_width = min(100, int(s['clarification_pct']))
    table_rows += f"""
    <tr>
        <td>{i+1}</td>
        <td><span class="project-tag">{s['project']}</span></td>
        <td class="prompt-cell" title="{prompt_escaped}">{prompt_escaped[:80]}{'...' if len(s['first_prompt']) > 80 else ''}</td>
        <td>{s['user_msgs']}</td>
        <td>{s['tool_calls']}</td>
        <td>{s['clarification_pct']}%
            <div class="mini-bar"><div class="mini-bar-fill" style="width:{bar_width}%"></div></div>
        </td>
        <td>{s['duration_min']}m</td>
        <td>{date}</td>
    </tr>"""

# Chart data
bucket_labels = json.dumps(list(buckets.keys()))
bucket_values = json.dumps(list(buckets.values()))

proj_labels = json.dumps(list(project_counts.keys()))
proj_values = json.dumps(list(project_counts.values()))

# Scatter data: user_msgs vs tool_calls for top sessions
scatter_data = json.dumps([{
    'x': s['tool_calls'],
    'y': s['user_msgs'],
    'label': s['project']
} for s in top20])

avg_clarification = sum(s['clarification_pct'] for s in top20) / len(top20) if top20 else 0
max_effort = top20[0]['combined_score'] if top20 else 0
total_frustrating = len([s for s in all_scores if s[0] >= 5])

html = f"""<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Сессии с долгими объяснениями</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{ background: #0a0a0a; color: #e5e5e5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 2rem 1rem; }}
  .container {{ max-width: 900px; margin: 0 auto; }}
  h1 {{ font-size: 1.5rem; margin-bottom: 0.25rem; color: #a78bfa; }}
  .subtitle {{ color: #888; font-size: 0.9rem; margin-bottom: 1.5rem; }}
  .metrics {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; margin-bottom: 2rem; }}
  .metric-card {{ background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 1rem; text-align: center; }}
  .metric-value {{ font-size: 1.8rem; font-weight: 700; color: #6366f1; }}
  .metric-label {{ font-size: 0.8rem; color: #888; margin-top: 0.25rem; }}
  .card {{ background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 1.25rem; margin-bottom: 1.5rem; }}
  .card h2 {{ font-size: 1rem; color: #8b5cf6; margin-bottom: 1rem; }}
  .charts-row {{ display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1.5rem; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 0.8rem; }}
  th {{ text-align: left; padding: 0.5rem; color: #888; border-bottom: 1px solid #2a2a2a; font-weight: 500; }}
  td {{ padding: 0.5rem; border-bottom: 1px solid #1a1a1a; }}
  tr:hover {{ background: #151515; }}
  .project-tag {{ background: #2a2a2a; padding: 2px 6px; border-radius: 4px; font-size: 0.75rem; color: #a78bfa; }}
  .prompt-cell {{ max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #999; }}
  .mini-bar {{ width: 50px; height: 4px; background: #2a2a2a; border-radius: 2px; margin-top: 2px; display: inline-block; }}
  .mini-bar-fill {{ height: 100%; background: #ef4444; border-radius: 2px; }}
  canvas {{ max-height: 220px; }}
  .explanation {{ color: #777; font-size: 0.8rem; margin-top: 0.75rem; line-height: 1.4; }}
</style>
</head>
<body>
<div class="container">
  <h1>Сессии с долгими объяснениями</h1>
  <p class="subtitle">Где вы тратили много сообщений на уточнения, а Claude мало делал (инструменты не вызывал)</p>

  <div class="metrics">
    <div class="metric-card">
      <div class="metric-value">{total_frustrating}</div>
      <div class="metric-label">Сессий с высоким effort (score 5+)</div>
    </div>
    <div class="metric-card">
      <div class="metric-value">{round(avg_clarification)}%</div>
      <div class="metric-label">Средний % уточнений в топ-20</div>
    </div>
    <div class="metric-card">
      <div class="metric-value">{top20[0]['user_msgs'] if top20 else 0}</div>
      <div class="metric-label">Макс. user-сообщений в топ-1</div>
    </div>
  </div>

  <div class="charts-row">
    <div class="card">
      <h2>Распределение Effort Score</h2>
      <canvas id="distChart"></canvas>
      <p class="explanation">Effort = (user_msgs / tool_calls) * log(user_msgs). Чем выше — тем больше объясняли.</p>
    </div>
    <div class="card">
      <h2>User Messages vs Tool Calls (топ-20)</h2>
      <canvas id="scatterChart"></canvas>
      <p class="explanation">Верхний левый угол = много сообщений, мало действий.</p>
    </div>
  </div>

  <div class="card">
    <h2>Топ-20 сессий с наибольшим количеством уточнений</h2>
    <div style="overflow-x:auto;">
    <table>
      <thead>
        <tr><th>#</th><th>Проект</th><th>Первый промпт</th><th>User msgs</th><th>Tools</th><th>% уточнений</th><th>Время</th><th>Дата</th></tr>
      </thead>
      <tbody>
        {table_rows}
      </tbody>
    </table>
    </div>
    <p class="explanation">% уточнений = доля ответов Claude без вызова инструментов (чистый текст). Высокий % = Claude переспрашивал или объяснял вместо того, чтобы делать.</p>
  </div>
</div>

<script>
const colors = ['#6366f1','#8b5cf6','#a78bfa','#06b6d4','#10b981','#f59e0b','#ef4444'];
Chart.defaults.color = '#888';
Chart.defaults.borderColor = '#2a2a2a';

new Chart(document.getElementById('distChart'), {{
  type: 'bar',
  data: {{
    labels: {bucket_labels},
    datasets: [{{ data: {bucket_values}, backgroundColor: colors, borderRadius: 4 }}]
  }},
  options: {{ responsive: true, plugins: {{ legend: {{ display: false }} }}, scales: {{ y: {{ grid: {{ color: '#1a1a1a' }} }}, x: {{ grid: {{ display: false }} }} }} }}
}});

const scatterData = {scatter_data};
new Chart(document.getElementById('scatterChart'), {{
  type: 'scatter',
  data: {{
    datasets: [{{
      data: scatterData,
      backgroundColor: '#ef4444aa',
      borderColor: '#ef4444',
      pointRadius: 6,
      pointHoverRadius: 8
    }}]
  }},
  options: {{
    responsive: true,
    plugins: {{
      legend: {{ display: false }},
      tooltip: {{
        callbacks: {{
          label: (ctx) => scatterData[ctx.dataIndex].label + ': ' + ctx.parsed.y + ' msgs, ' + ctx.parsed.x + ' tools'
        }}
      }}
    }},
    scales: {{
      x: {{ title: {{ display: true, text: 'Tool Calls' }}, grid: {{ color: '#1a1a1a' }} }},
      y: {{ title: {{ display: true, text: 'User Messages' }}, grid: {{ color: '#1a1a1a' }} }}
    }}
  }}
}});
</script>
</body>
</html>"""

with open(OUT, 'w') as f:
    f.write(html)

print(f"Generated report with {len(top20)} top sessions")
print(f"REPORT_READY:{OUT}")
