import sqlite3
import json

DB = "/Users/vova/Documents/GitHub/claude-session-manager/data/analytics.db"
OUT = "/Users/vova/Documents/GitHub/claude-session-manager/data/reports/report-1772784229788.html"

# Pricing per million tokens (USD) - Claude Opus 4.6 / Sonnet 4.6
# Using blended rates: input $15, cache_read $1.5, cache_creation $18.75, output $75, thinking $15 (Opus)
# Sonnet: input $3, cache_read $0.30, cache_creation $3.75, output $15, thinking $3
PRICING = {
    "claude-opus-4-6": {"input": 15, "cache_read": 1.5, "cache_creation": 18.75, "output": 75},
    "claude-sonnet-4-6": {"input": 3, "cache_read": 0.30, "cache_creation": 3.75, "output": 15},
}
DEFAULT_PRICING = PRICING["claude-sonnet-4-6"]

conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

# Get per-session costs grouped by project
rows = conn.execute("""
    SELECT
        project_dir,
        model,
        COALESCE(total_input_tokens, 0) as input_tok,
        COALESCE(total_output_tokens, 0) as output_tok,
        COALESCE(total_cache_read_tokens, 0) as cache_read_tok,
        COALESCE(total_cache_creation_tokens, 0) as cache_create_tok,
        COALESCE(total_thinking_tokens, 0) as thinking_tok,
        session_id
    FROM sessions
    WHERE is_subagent = 0 AND project_dir IS NOT NULL
""").fetchall()

project_costs = {}
project_tokens = {}
project_sessions = {}

for r in rows:
    proj = r["project_dir"]
    # Get readable name
    if "GitHub-" in (proj or ""):
        name = proj.split("GitHub-")[-1]
    elif proj:
        name = proj.strip("-").split("-")[-1]
    else:
        name = "unknown"

    model = r["model"] or ""
    pricing = PRICING.get(model, DEFAULT_PRICING)

    cost = (
        r["input_tok"] * pricing["input"] / 1_000_000
        + r["cache_read_tok"] * pricing["cache_read"] / 1_000_000
        + r["cache_create_tok"] * pricing["cache_creation"] / 1_000_000
        + r["output_tok"] * pricing["output"] / 1_000_000
    )

    project_costs[name] = project_costs.get(name, 0) + cost
    total_tok = r["input_tok"] + r["output_tok"] + r["cache_read_tok"] + r["cache_create_tok"]
    project_tokens[name] = project_tokens.get(name, 0) + total_tok
    project_sessions[name] = project_sessions.get(name, 0) + 1

# Top 5 by cost
top5 = sorted(project_costs.items(), key=lambda x: x[1], reverse=True)[:5]
top5_names = [t[0] for t in top5]
top5_costs = [round(t[1], 2) for t in top5]
top5_tokens = [project_tokens[t[0]] for t in top5]
top5_sessions_count = [project_sessions[t[0]] for t in top5]

total_cost = sum(project_costs.values())
total_projects = len(project_costs)

# Cost breakdown per top project (input vs cache vs output)
breakdown = {}
for r in rows:
    proj = r["project_dir"]
    if "GitHub-" in (proj or ""):
        name = proj.split("GitHub-")[-1]
    elif proj:
        name = proj.strip("-").split("-")[-1]
    else:
        name = "unknown"
    if name not in top5_names:
        continue

    model = r["model"] or ""
    pricing = PRICING.get(model, DEFAULT_PRICING)

    input_cost = r["input_tok"] * pricing["input"] / 1_000_000
    cache_cost = (r["cache_read_tok"] * pricing["cache_read"] + r["cache_create_tok"] * pricing["cache_creation"]) / 1_000_000
    output_cost = r["output_tok"] * pricing["output"] / 1_000_000

    if name not in breakdown:
        breakdown[name] = {"input": 0, "cache": 0, "output": 0}
    breakdown[name]["input"] += input_cost
    breakdown[name]["cache"] += cache_cost
    breakdown[name]["output"] += output_cost

bd_input = [round(breakdown[n]["input"], 2) for n in top5_names]
bd_cache = [round(breakdown[n]["cache"], 2) for n in top5_names]
bd_output = [round(breakdown[n]["output"], 2) for n in top5_names]

conn.close()

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
  h1 {{ font-size: 1.6rem; margin-bottom: 0.5rem; color: #fff; }}
  .subtitle {{ color: #888; font-size: 0.9rem; margin-bottom: 1.5rem; }}
  .metrics {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; margin-bottom: 2rem; }}
  .metric {{ background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 10px; padding: 1.2rem; }}
  .metric .label {{ color: #888; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; }}
  .metric .value {{ font-size: 1.5rem; font-weight: 700; color: #fff; margin-top: 0.3rem; }}
  .card {{ background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 10px; padding: 1.5rem; margin-bottom: 1.5rem; }}
  .card h2 {{ font-size: 1.1rem; margin-bottom: 1rem; color: #fff; }}
  .chart-wrap {{ position: relative; height: 320px; }}
  table {{ width: 100%; border-collapse: collapse; margin-top: 0.5rem; }}
  th, td {{ text-align: left; padding: 0.6rem 0.8rem; border-bottom: 1px solid #2a2a2a; font-size: 0.9rem; }}
  th {{ color: #888; font-weight: 500; font-size: 0.8rem; text-transform: uppercase; }}
  td.num {{ text-align: right; font-variant-numeric: tabular-nums; }}
  th.num {{ text-align: right; }}
  .bar {{ display: inline-block; height: 8px; border-radius: 4px; background: #6366f1; }}
</style>
</head>
<body>
<div class="container">
  <h1>Top 5 Projects by Token Cost</h1>
  <p class="subtitle">Estimated API cost based on published Claude pricing</p>

  <div class="metrics">
    <div class="metric"><div class="label">Total Spend (est.)</div><div class="value">${total_cost:,.2f}</div></div>
    <div class="metric"><div class="label">Top Project</div><div class="value">{top5_names[0]}</div></div>
    <div class="metric"><div class="label">Projects Tracked</div><div class="value">{total_projects}</div></div>
  </div>

  <div class="card">
    <h2>Cost by Project</h2>
    <div class="chart-wrap"><canvas id="barChart"></canvas></div>
  </div>

  <div class="card">
    <h2>Cost Breakdown: Input vs Cache vs Output</h2>
    <div class="chart-wrap"><canvas id="stackedChart"></canvas></div>
  </div>

  <div class="card">
    <h2>Details</h2>
    <table>
      <tr><th>#</th><th>Project</th><th class="num">Cost</th><th class="num">Sessions</th><th class="num">Tokens</th></tr>
      {"".join(f'<tr><td>{i+1}</td><td>{n}</td><td class="num">${c:,.2f}</td><td class="num">{project_sessions[n]}</td><td class="num">{project_tokens[n]:,}</td></tr>' for i, (n, c) in enumerate(top5))}
    </table>
  </div>
</div>

<script>
const labels = {json.dumps(top5_names)};
const costs = {json.dumps(top5_costs)};
const colors = ['#6366f1','#8b5cf6','#a78bfa','#06b6d4','#10b981'];

Chart.defaults.color = '#888';
Chart.defaults.borderColor = '#2a2a2a';

new Chart(document.getElementById('barChart'), {{
  type: 'bar',
  data: {{
    labels,
    datasets: [{{ label: 'Cost ($)', data: costs, backgroundColor: colors, borderRadius: 6, maxBarThickness: 60 }}]
  }},
  options: {{
    responsive: true, maintainAspectRatio: false,
    plugins: {{ legend: {{ display: false }} }},
    scales: {{
      y: {{ ticks: {{ callback: v => '$' + v }}, grid: {{ color: '#1f1f1f' }} }},
      x: {{ grid: {{ display: false }} }}
    }}
  }}
}});

new Chart(document.getElementById('stackedChart'), {{
  type: 'bar',
  data: {{
    labels,
    datasets: [
      {{ label: 'Input', data: {json.dumps(bd_input)}, backgroundColor: '#6366f1', borderRadius: 4 }},
      {{ label: 'Cache', data: {json.dumps(bd_cache)}, backgroundColor: '#06b6d4', borderRadius: 4 }},
      {{ label: 'Output', data: {json.dumps(bd_output)}, backgroundColor: '#f59e0b', borderRadius: 4 }}
    ]
  }},
  options: {{
    responsive: true, maintainAspectRatio: false,
    plugins: {{ legend: {{ labels: {{ boxWidth: 12, padding: 16 }} }} }},
    scales: {{
      x: {{ stacked: true, grid: {{ display: false }} }},
      y: {{ stacked: true, ticks: {{ callback: v => '$' + v }}, grid: {{ color: '#1f1f1f' }} }}
    }}
  }}
}});
</script>
</body>
</html>"""

with open(OUT, "w") as f:
    f.write(html)

print(f"REPORT_READY:{OUT}")
