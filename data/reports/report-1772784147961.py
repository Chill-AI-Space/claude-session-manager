import sqlite3
import json
from datetime import datetime
from statistics import median, mean

DB = "/Users/vova/Documents/GitHub/claude-session-manager/data/analytics.db"
OUT = "/Users/vova/Documents/GitHub/claude-session-manager/data/reports/report-1772784147961.html"

conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

# Measure compact duration: time between last message before compact and the compact timestamp
rows = conn.execute("""
    SELECT
        c.id, c.session_id, c.timestamp as compact_ts,
        c.pre_input_tokens, c.post_input_tokens, c.summary_length,
        (SELECT m.timestamp FROM messages m
         WHERE m.session_id = c.session_id AND m.line_number < c.line_number
         ORDER BY m.line_number DESC LIMIT 1) as prev_msg_ts,
        s.project_dir
    FROM compacts c
    JOIN sessions s ON s.session_id = c.session_id
    WHERE s.is_subagent = 0
""").fetchall()

durations = []
for r in rows:
    if not r["prev_msg_ts"] or not r["compact_ts"]:
        continue
    try:
        t1 = datetime.fromisoformat(r["prev_msg_ts"].replace("Z", "+00:00"))
        t2 = datetime.fromisoformat(r["compact_ts"].replace("Z", "+00:00"))
        dur = (t2 - t1).total_seconds()
        if 5 < dur < 600:  # filter outliers: 5s to 10min
            durations.append({
                "duration": dur,
                "pre_tokens": r["pre_input_tokens"],
                "post_tokens": r["post_input_tokens"],
                "summary_length": r["summary_length"],
                "project": r["project_dir"].split("GitHub-")[-1] if r["project_dir"] and "GitHub-" in r["project_dir"] else (r["project_dir"] or "unknown"),
                "compression_ratio": round(r["post_input_tokens"] / r["pre_input_tokens"] * 100, 1) if r["pre_input_tokens"] else 0
            })
    except Exception:
        continue

# Stats
avg_dur = mean(d["duration"] for d in durations)
med_dur = median(d["duration"] for d in durations)
min_dur = min(d["duration"] for d in durations)
max_dur = max(d["duration"] for d in durations)
total = len(durations)

# Histogram buckets (10s intervals)
buckets = {}
for d in durations:
    bucket = int(d["duration"] // 10) * 10
    label = f"{bucket}-{bucket+10}s"
    buckets[label] = buckets.get(label, 0) + 1
sorted_buckets = sorted(buckets.items(), key=lambda x: int(x[0].split("-")[0]))
hist_labels = [b[0] for b in sorted_buckets]
hist_values = [b[1] for b in sorted_buckets]

# Duration by pre_input_tokens (scatter data)
scatter_data = [{"x": d["pre_tokens"], "y": round(d["duration"], 1)} for d in durations]

# Average duration by project (top 10 by compact count)
proj_stats = {}
for d in durations:
    p = d["project"]
    if p not in proj_stats:
        proj_stats[p] = []
    proj_stats[p].append(d["duration"])
top_projects = sorted(proj_stats.items(), key=lambda x: -len(x[1]))[:10]
proj_labels = [p[0] for p in top_projects]
proj_avgs = [round(mean(p[1]), 1) for p in top_projects]
proj_counts = [len(p[1]) for p in top_projects]

avg_compression = mean(d["compression_ratio"] for d in durations)

conn.close()

html = f"""<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Время компакта сессий Claude</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{ background: #0a0a0a; color: #e5e5e5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 24px; }}
  .container {{ max-width: 900px; margin: 0 auto; }}
  h1 {{ font-size: 1.6rem; margin-bottom: 8px; color: #f5f5f5; }}
  .subtitle {{ color: #888; font-size: 0.9rem; margin-bottom: 24px; }}
  .metrics {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 28px; }}
  .metric {{ background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 10px; padding: 16px; text-align: center; }}
  .metric .value {{ font-size: 1.8rem; font-weight: 700; color: #a78bfa; }}
  .metric .label {{ font-size: 0.75rem; color: #888; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }}
  .card {{ background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 10px; padding: 20px; margin-bottom: 20px; }}
  .card h2 {{ font-size: 1rem; margin-bottom: 14px; color: #d4d4d4; }}
  canvas {{ max-height: 320px; }}
</style>
</head>
<body>
<div class="container">
  <h1>Время компакта сессий Claude</h1>
  <p class="subtitle">Анализ {total} компактов (фильтр: 5-600с, только основные сессии)</p>

  <div class="metrics">
    <div class="metric"><div class="value">{avg_dur:.0f}с</div><div class="label">Среднее</div></div>
    <div class="metric"><div class="value">{med_dur:.0f}с</div><div class="label">Медиана</div></div>
    <div class="metric"><div class="value">{min_dur:.0f}с</div><div class="label">Минимум</div></div>
    <div class="metric"><div class="value">{max_dur:.0f}с</div><div class="label">Максимум</div></div>
    <div class="metric"><div class="value">{avg_compression:.0f}%</div><div class="label">Ср. сжатие (пост/пре)</div></div>
    <div class="metric"><div class="value">{total}</div><div class="label">Всего компактов</div></div>
  </div>

  <div class="card">
    <h2>Распределение времени компакта</h2>
    <canvas id="histChart"></canvas>
  </div>

  <div class="card">
    <h2>Время компакта vs размер контекста (pre_input_tokens)</h2>
    <canvas id="scatterChart"></canvas>
  </div>

  <div class="card">
    <h2>Среднее время компакта по проектам (топ-10)</h2>
    <canvas id="projChart"></canvas>
  </div>
</div>

<script>
const colors = ['#6366f1','#8b5cf6','#a78bfa','#06b6d4','#10b981','#f59e0b','#ef4444'];
Chart.defaults.color = '#888';
Chart.defaults.borderColor = '#2a2a2a';

new Chart(document.getElementById('histChart'), {{
  type: 'bar',
  data: {{
    labels: {json.dumps(hist_labels)},
    datasets: [{{ data: {json.dumps(hist_values)}, backgroundColor: '#6366f1', borderRadius: 4 }}]
  }},
  options: {{ plugins: {{ legend: {{ display: false }} }}, scales: {{ y: {{ title: {{ display: true, text: 'Кол-во компактов' }} }}, x: {{ title: {{ display: true, text: 'Длительность' }} }} }} }}
}});

new Chart(document.getElementById('scatterChart'), {{
  type: 'scatter',
  data: {{
    datasets: [{{ data: {json.dumps(scatter_data)}, backgroundColor: '#8b5cf680', pointRadius: 3 }}]
  }},
  options: {{ plugins: {{ legend: {{ display: false }} }}, scales: {{ x: {{ title: {{ display: true, text: 'Pre-compact tokens' }} }}, y: {{ title: {{ display: true, text: 'Секунды' }} }} }} }}
}});

new Chart(document.getElementById('projChart'), {{
  type: 'bar',
  data: {{
    labels: {json.dumps(proj_labels)},
    datasets: [
      {{ label: 'Ср. время (с)', data: {json.dumps(proj_avgs)}, backgroundColor: '#a78bfa', borderRadius: 4 }},
    ]
  }},
  options: {{ indexAxis: 'y', plugins: {{ legend: {{ display: false }}, tooltip: {{ callbacks: {{ afterLabel: function(ctx) {{ return 'Компактов: ' + {json.dumps(proj_counts)}[ctx.dataIndex]; }} }} }} }}, scales: {{ x: {{ title: {{ display: true, text: 'Секунды' }} }} }} }}
}});
</script>
</body>
</html>"""

with open(OUT, "w") as f:
    f.write(html)

print(f"Generated report with {total} compacts")
print(f"Avg: {avg_dur:.1f}s, Median: {med_dur:.1f}s")
print(f"REPORT_READY:{OUT}")
