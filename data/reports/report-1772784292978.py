import sqlite3
import json

DB = "/Users/vova/Documents/GitHub/claude-session-manager/data/analytics.db"
OUT = "/Users/vova/Documents/GitHub/claude-session-manager/data/reports/report-1772784292978.html"

# Pricing per 1M tokens (USD) - Claude Opus 4 / Sonnet 4
PRICING = {
    "claude-opus-4-6":   {"input": 15.0, "output": 75.0, "cache_read": 1.5, "cache_create": 18.75},
    "claude-sonnet-4-6": {"input": 3.0,  "output": 15.0, "cache_read": 0.3, "cache_create": 3.75},
    # Fallbacks for older model strings
    "claude-sonnet-4-5-20250514": {"input": 3.0, "output": 15.0, "cache_read": 0.3, "cache_create": 3.75},
}
DEFAULT_PRICING = {"input": 3.0, "output": 15.0, "cache_read": 0.3, "cache_create": 3.75}

conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

# Get per-session costs grouped by project
rows = conn.execute("""
    SELECT
        session_id,
        project_dir,
        model,
        COALESCE(total_input_tokens, 0) as input_tokens,
        COALESCE(total_output_tokens, 0) as output_tokens,
        COALESCE(total_cache_read_tokens, 0) as cache_read,
        COALESCE(total_cache_creation_tokens, 0) as cache_create,
        COALESCE(total_thinking_tokens, 0) as thinking_tokens,
        COALESCE(message_count, 0) as message_count
    FROM sessions
    WHERE is_subagent = 0
""").fetchall()

# Calculate costs per project
projects = {}
for r in rows:
    proj = r["project_dir"] or "unknown"
    # Extract readable name
    if "GitHub-" in proj:
        name = proj.split("GitHub-")[-1]
    elif proj.startswith("-Users-"):
        parts = proj.strip("-").split("-")
        name = parts[-1] if parts else proj
    else:
        name = proj

    model = r["model"] or ""
    pricing = DEFAULT_PRICING
    for key, p in PRICING.items():
        if key in model:
            pricing = p
            break

    cost = (
        r["input_tokens"] * pricing["input"] / 1_000_000 +
        r["output_tokens"] * pricing["output"] / 1_000_000 +
        r["cache_read"] * pricing["cache_read"] / 1_000_000 +
        r["cache_create"] * pricing["cache_create"] / 1_000_000
    )

    if name not in projects:
        projects[name] = {"cost": 0, "sessions": 0, "input": 0, "output": 0, "cache_read": 0, "messages": 0}
    projects[name]["cost"] += cost
    projects[name]["sessions"] += 1
    projects[name]["input"] += r["input_tokens"]
    projects[name]["output"] += r["output_tokens"]
    projects[name]["cache_read"] += r["cache_read"]
    projects[name]["messages"] += r["message_count"]

conn.close()

# Top 5
top5 = sorted(projects.items(), key=lambda x: x[1]["cost"], reverse=True)[:5]
total_cost = sum(p["cost"] for p in projects.values())
total_sessions = sum(p["sessions"] for p in projects.values())

labels = [t[0] for t in top5]
costs = [round(t[1]["cost"], 2) for t in top5]
sessions = [t[1]["sessions"] for t in top5]
cost_per_session = [round(t[1]["cost"] / t[1]["sessions"], 2) if t[1]["sessions"] > 0 else 0 for t in top5]

# Rest cost
rest_cost = round(total_cost - sum(costs), 2)

colors = ["#6366f1", "#8b5cf6", "#a78bfa", "#06b6d4", "#10b981", "#f59e0b", "#ef4444"]

html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Top 5 Projects by Token Cost</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{ background: #0a0a0a; color: #e5e5e5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 2rem 1rem; }}
.container {{ max-width: 900px; margin: 0 auto; }}
h1 {{ font-size: 1.5rem; margin-bottom: 0.5rem; }}
.subtitle {{ color: #888; margin-bottom: 1.5rem; font-size: 0.9rem; }}
.metrics {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; margin-bottom: 2rem; }}
.metric {{ background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 1rem; }}
.metric .value {{ font-size: 1.5rem; font-weight: 700; color: #6366f1; }}
.metric .label {{ font-size: 0.8rem; color: #888; margin-top: 0.25rem; }}
.card {{ background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; }}
.card h2 {{ font-size: 1.1rem; margin-bottom: 1rem; }}
.chart-wrap {{ position: relative; height: 320px; }}
table {{ width: 100%; border-collapse: collapse; font-size: 0.85rem; }}
th, td {{ text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #2a2a2a; }}
th {{ color: #888; font-weight: 500; }}
td.num {{ text-align: right; font-variant-numeric: tabular-nums; }}
th.num {{ text-align: right; }}
tr:hover td {{ background: #222; }}
.bar-col {{ color: #6366f1; font-weight: 600; }}
</style>
</head>
<body>
<div class="container">
<h1>Top 5 Projects by Token Cost</h1>
<p class="subtitle">Estimated API cost based on published Claude pricing</p>

<div class="metrics">
  <div class="metric"><div class="value">${total_cost:.2f}</div><div class="label">Total cost (all projects)</div></div>
  <div class="metric"><div class="value">${sum(costs):.2f}</div><div class="label">Top 5 combined</div></div>
  <div class="metric"><div class="value">{total_sessions}</div><div class="label">Total sessions</div></div>
</div>

<div class="card">
  <h2>Cost by Project</h2>
  <div class="chart-wrap"><canvas id="barChart"></canvas></div>
</div>

<div class="card">
  <h2>Cost Distribution</h2>
  <div class="chart-wrap" style="height:280px;max-width:400px;margin:0 auto;"><canvas id="pieChart"></canvas></div>
</div>

<div class="card">
  <h2>Breakdown</h2>
  <table>
    <tr><th>Project</th><th class="num">Cost</th><th class="num">Sessions</th><th class="num">$/Session</th></tr>
    {"".join(f'<tr><td>{labels[i]}</td><td class="num bar-col">${costs[i]:.2f}</td><td class="num">{sessions[i]}</td><td class="num">${cost_per_session[i]:.2f}</td></tr>' for i in range(len(top5)))}
  </table>
</div>
</div>

<script>
const colors = {json.dumps(colors[:5])};
const labels = {json.dumps(labels)};
const costs = {json.dumps(costs)};

new Chart(document.getElementById('barChart'), {{
  type: 'bar',
  data: {{
    labels: labels,
    datasets: [{{ data: costs, backgroundColor: colors, borderRadius: 4 }}]
  }},
  options: {{
    indexAxis: 'y',
    responsive: true, maintainAspectRatio: false,
    plugins: {{ legend: {{ display: false }},
      tooltip: {{ callbacks: {{ label: ctx => '$' + ctx.parsed.x.toFixed(2) }} }}
    }},
    scales: {{
      x: {{ grid: {{ color: '#2a2a2a' }}, ticks: {{ color: '#888', callback: v => '$' + v }} }},
      y: {{ grid: {{ display: false }}, ticks: {{ color: '#e5e5e5' }} }}
    }}
  }}
}});

const pieLabels = [...labels, 'Others'];
const pieData = [...costs, {rest_cost}];
const pieColors = [...colors, '#333'];
new Chart(document.getElementById('pieChart'), {{
  type: 'doughnut',
  data: {{ labels: pieLabels, datasets: [{{ data: pieData, backgroundColor: pieColors, borderWidth: 0 }}] }},
  options: {{
    responsive: true, maintainAspectRatio: false,
    plugins: {{
      legend: {{ position: 'right', labels: {{ color: '#e5e5e5', boxWidth: 12, padding: 8, font: {{ size: 11 }} }} }},
      tooltip: {{ callbacks: {{ label: ctx => ctx.label + ': $' + ctx.parsed.toFixed(2) }} }}
    }}
  }}
}});
</script>
</body>
</html>"""

with open(OUT, "w") as f:
    f.write(html)

print(f"REPORT_READY:{OUT}")
