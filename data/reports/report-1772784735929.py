import sqlite3
import json
from datetime import datetime, timedelta

DB = "/Users/vova/Documents/GitHub/claude-session-manager/data/analytics.db"
OUT = "/Users/vova/Documents/GitHub/claude-session-manager/data/reports/report-1772784735929.html"

conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

# Last month cutoff
cutoff = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%S")

# Top projects by total tokens (input + output + cache_read + cache_creation)
rows = conn.execute("""
    SELECT
        project_path,
        COUNT(*) as session_count,
        SUM(total_input_tokens) as input_tok,
        SUM(total_output_tokens) as output_tok,
        SUM(total_cache_read_tokens) as cache_read_tok,
        SUM(total_cache_creation_tokens) as cache_create_tok,
        SUM(total_thinking_tokens) as thinking_tok,
        SUM(total_input_tokens + total_output_tokens + COALESCE(total_cache_read_tokens,0) + COALESCE(total_cache_creation_tokens,0)) as total_tok
    FROM sessions
    WHERE is_subagent = 0
      AND started_at >= ?
      AND project_path IS NOT NULL
    GROUP BY project_path
    ORDER BY total_tok DESC
""", (cutoff,)).fetchall()

# Summary stats
total_all = sum(r["total_tok"] or 0 for r in rows)
total_sessions = sum(r["session_count"] for r in rows)
num_projects = len(rows)

# Top 12 for chart, rest grouped as "Other"
top_n = 12
top_rows = rows[:top_n]
other_tok = sum(r["total_tok"] or 0 for r in rows[top_n:])

def project_name(path):
    if not path:
        return "unknown"
    if "GitHub/" in path:
        return path.split("GitHub/")[-1]
    parts = path.rstrip("/").split("/")
    return parts[-1] if parts else path

chart_labels = [project_name(r["project_path"]) for r in top_rows]
chart_input = [r["input_tok"] or 0 for r in top_rows]
chart_output = [r["output_tok"] or 0 for r in top_rows]
chart_cache = [(r["cache_read_tok"] or 0) + (r["cache_create_tok"] or 0) for r in top_rows]

if other_tok > 0:
    chart_labels.append("Other")
    other_input = sum(r["input_tok"] or 0 for r in rows[top_n:])
    other_output = sum(r["output_tok"] or 0 for r in rows[top_n:])
    other_cache = sum((r["cache_read_tok"] or 0) + (r["cache_create_tok"] or 0) for r in rows[top_n:])
    chart_input.append(other_input)
    chart_output.append(other_output)
    chart_cache.append(other_cache)

# Cost estimate (rough: $15/M input, $75/M output for Opus; cache_read ~$1.5/M)
def estimate_cost(r):
    inp = (r["input_tok"] or 0) / 1e6 * 15
    out = (r["output_tok"] or 0) / 1e6 * 75
    cr = (r["cache_read_tok"] or 0) / 1e6 * 1.5
    cc = (r["cache_create_tok"] or 0) / 1e6 * 15
    return inp + out + cr + cc

cost_labels = [project_name(r["project_path"]) for r in rows[:10]]
cost_values = [round(estimate_cost(r), 2) for r in rows[:10]]
total_cost = sum(estimate_cost(r) for r in rows)

# Table data — all projects
table_rows_html = ""
for i, r in enumerate(rows):
    name = project_name(r["project_path"])
    tok_m = (r["total_tok"] or 0) / 1e6
    pct = ((r["total_tok"] or 0) / total_all * 100) if total_all else 0
    cost = estimate_cost(r)
    table_rows_html += f"""<tr>
        <td>{i+1}</td>
        <td>{name}</td>
        <td>{r['session_count']}</td>
        <td>{tok_m:.1f}M</td>
        <td>{pct:.1f}%</td>
        <td>${cost:.2f}</td>
    </tr>"""

def fmt(n):
    if n >= 1e9: return f"{n/1e9:.1f}B"
    if n >= 1e6: return f"{n/1e6:.1f}M"
    if n >= 1e3: return f"{n/1e3:.0f}K"
    return str(n)

html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Token Cost by Project — Last 30 Days</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{ background: #0a0a0a; color: #e5e5e5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 2rem 1rem; }}
.container {{ max-width: 900px; margin: 0 auto; }}
h1 {{ font-size: 1.5rem; margin-bottom: 0.3rem; }}
.subtitle {{ color: #888; margin-bottom: 1.5rem; font-size: 0.9rem; }}
.metrics {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 2rem; }}
.metric {{ background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 1rem; }}
.metric .label {{ color: #888; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; }}
.metric .value {{ font-size: 1.4rem; font-weight: 600; margin-top: 0.3rem; }}
.card {{ background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; }}
.card h2 {{ font-size: 1.1rem; margin-bottom: 1rem; }}
canvas {{ max-height: 400px; }}
table {{ width: 100%; border-collapse: collapse; font-size: 0.85rem; }}
th, td {{ padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid #2a2a2a; }}
th {{ color: #888; font-weight: 500; text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.05em; }}
td:nth-child(n+3) {{ text-align: right; }}
th:nth-child(n+3) {{ text-align: right; }}
tr:hover {{ background: #222; }}
</style>
</head>
<body>
<div class="container">
    <h1>Token Cost by Project</h1>
    <p class="subtitle">Last 30 days (since {cutoff[:10]}) — main sessions only</p>

    <div class="metrics">
        <div class="metric"><div class="label">Total Tokens</div><div class="value">{fmt(total_all)}</div></div>
        <div class="metric"><div class="label">Est. Cost</div><div class="value" style="color:#f59e0b">${total_cost:.0f}</div></div>
        <div class="metric"><div class="label">Projects</div><div class="value">{num_projects}</div></div>
        <div class="metric"><div class="label">Sessions</div><div class="value">{total_sessions}</div></div>
    </div>

    <div class="card">
        <h2>Top Projects by Token Usage</h2>
        <canvas id="barChart"></canvas>
    </div>

    <div class="card">
        <h2>Estimated Cost (USD) — Top 10</h2>
        <canvas id="costChart"></canvas>
    </div>

    <div class="card">
        <h2>All Projects</h2>
        <table>
            <thead><tr><th>#</th><th>Project</th><th>Sessions</th><th>Tokens</th><th>Share</th><th>Est. Cost</th></tr></thead>
            <tbody>{table_rows_html}</tbody>
        </table>
    </div>
</div>

<script>
const colors = ['#6366f1','#8b5cf6','#a78bfa','#06b6d4','#10b981','#f59e0b','#ef4444','#ec4899','#14b8a6','#f97316','#84cc16','#78716c','#94a3b8'];
Chart.defaults.color = '#888';
Chart.defaults.borderColor = '#2a2a2a';

new Chart(document.getElementById('barChart'), {{
    type: 'bar',
    data: {{
        labels: {json.dumps(chart_labels)},
        datasets: [
            {{ label: 'Input', data: {json.dumps(chart_input)}, backgroundColor: '#6366f1' }},
            {{ label: 'Output', data: {json.dumps(chart_output)}, backgroundColor: '#8b5cf6' }},
            {{ label: 'Cache', data: {json.dumps(chart_cache)}, backgroundColor: '#06b6d4' }}
        ]
    }},
    options: {{
        responsive: true,
        plugins: {{ legend: {{ position: 'top' }} }},
        scales: {{
            x: {{ stacked: true, ticks: {{ maxRotation: 45 }} }},
            y: {{ stacked: true, ticks: {{ callback: v => (v/1e6).toFixed(0)+'M' }} }}
        }}
    }}
}});

new Chart(document.getElementById('costChart'), {{
    type: 'bar',
    data: {{
        labels: {json.dumps(cost_labels)},
        datasets: [{{ label: 'Est. USD', data: {json.dumps(cost_values)}, backgroundColor: colors.slice(0, {len(cost_values)}) }}]
    }},
    options: {{
        indexAxis: 'y',
        responsive: true,
        plugins: {{ legend: {{ display: false }} }},
        scales: {{ x: {{ ticks: {{ callback: v => '$'+v }} }} }}
    }}
}});
</script>
</body>
</html>"""

conn.close()

with open(OUT, "w") as f:
    f.write(html)

print(f"REPORT_READY:{OUT}")
