#!/usr/bin/env python3
import sqlite3
import json
from pathlib import Path

DB = "/Users/vova/Documents/GitHub/claude-session-manager/data/analytics.db"
OUT = "/Users/vova/Documents/GitHub/claude-session-manager/data/reports/report-1772785338895.html"

conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

# Average session duration per project (main sessions only, with valid duration)
rows = conn.execute("""
    SELECT
        project_path,
        COUNT(*) as session_count,
        AVG(duration_seconds) as avg_duration,
        MIN(duration_seconds) as min_duration,
        MAX(duration_seconds) as max_duration,
        SUM(duration_seconds) as total_duration
    FROM sessions
    WHERE is_subagent = 0
      AND duration_seconds IS NOT NULL
      AND duration_seconds > 0
      AND project_path IS NOT NULL
      AND project_path != ''
    GROUP BY project_path
    HAVING session_count >= 3
    ORDER BY avg_duration DESC
""").fetchall()

conn.close()

def extract_project_name(path):
    if not path:
        return "unknown"
    if "GitHub/" in path:
        return path.split("GitHub/")[-1]
    return path.split("/")[-1]

def fmt_duration(seconds):
    if seconds is None:
        return "N/A"
    if seconds < 60:
        return f"{seconds:.0f}s"
    if seconds < 3600:
        return f"{seconds/60:.1f}m"
    return f"{seconds/3600:.1f}h"

projects = []
for r in rows:
    projects.append({
        "name": extract_project_name(r["project_path"]),
        "path": r["project_path"],
        "count": r["session_count"],
        "avg": r["avg_duration"],
        "min": r["min_duration"],
        "max": r["max_duration"],
        "total": r["total_duration"],
    })

# Top 15 by session count for chart readability
chart_projects = sorted(projects, key=lambda x: x["count"], reverse=True)[:15]
chart_projects.sort(key=lambda x: x["avg"], reverse=True)

labels = json.dumps([p["name"] for p in chart_projects])
avg_mins = json.dumps([round(p["avg"] / 60, 1) for p in chart_projects])
counts = json.dumps([p["count"] for p in chart_projects])
max_mins = json.dumps([round(p["max"] / 60, 1) for p in chart_projects])

# Summary metrics
total_sessions = sum(p["count"] for p in projects)
overall_avg = sum(p["avg"] * p["count"] for p in projects) / total_sessions if total_sessions else 0
longest_project = max(projects, key=lambda x: x["avg"]) if projects else None
most_used = max(projects, key=lambda x: x["count"]) if projects else None

# Table rows (all projects, sorted by avg desc)
table_rows = ""
for p in sorted(projects, key=lambda x: x["avg"], reverse=True):
    table_rows += f"""<tr>
        <td>{p["name"]}</td>
        <td>{p["count"]}</td>
        <td><strong>{fmt_duration(p["avg"])}</strong></td>
        <td>{fmt_duration(p["min"])}</td>
        <td>{fmt_duration(p["max"])}</td>
        <td>{fmt_duration(p["total"])}</td>
    </tr>"""

html = f"""<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Средняя длительность сессии по проектам</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{ background: #0a0a0a; color: #e5e5e5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 2rem 1rem; }}
.container {{ max-width: 900px; margin: 0 auto; }}
h1 {{ font-size: 1.5rem; margin-bottom: 0.5rem; }}
.subtitle {{ color: #888; margin-bottom: 2rem; font-size: 0.9rem; }}
.metrics {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 2rem; }}
.metric {{ background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 1rem; }}
.metric .value {{ font-size: 1.5rem; font-weight: 700; color: #a78bfa; }}
.metric .label {{ font-size: 0.8rem; color: #888; margin-top: 0.25rem; }}
.card {{ background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; }}
.card h2 {{ font-size: 1.1rem; margin-bottom: 1rem; }}
table {{ width: 100%; border-collapse: collapse; font-size: 0.85rem; }}
th {{ text-align: left; padding: 0.5rem; border-bottom: 1px solid #2a2a2a; color: #888; font-weight: 500; }}
td {{ padding: 0.5rem; border-bottom: 1px solid #1a1a1a; }}
tr:hover td {{ background: #222; }}
canvas {{ max-height: 400px; }}
</style>
</head>
<body>
<div class="container">
    <h1>Средняя длительность сессии по проектам</h1>
    <p class="subtitle">Только основные сессии (без subagent), проекты с 3+ сессиями</p>

    <div class="metrics">
        <div class="metric">
            <div class="value">{fmt_duration(overall_avg)}</div>
            <div class="label">Средняя длительность (все проекты)</div>
        </div>
        <div class="metric">
            <div class="value">{total_sessions}</div>
            <div class="label">Всего сессий</div>
        </div>
        <div class="metric">
            <div class="value">{longest_project["name"] if longest_project else "—"}</div>
            <div class="label">Самый долгий проект ({fmt_duration(longest_project["avg"]) if longest_project else "—"} ср.)</div>
        </div>
        <div class="metric">
            <div class="value">{most_used["name"] if most_used else "—"}</div>
            <div class="label">Самый частый проект ({most_used["count"] if most_used else 0} сессий)</div>
        </div>
    </div>

    <div class="card">
        <h2>Средняя длительность (мин) — топ-15 проектов</h2>
        <canvas id="avgChart"></canvas>
    </div>

    <div class="card">
        <h2>Средняя vs максимальная длительность (мин)</h2>
        <canvas id="compareChart"></canvas>
    </div>

    <div class="card">
        <h2>Все проекты</h2>
        <div style="overflow-x:auto">
        <table>
            <thead><tr><th>Проект</th><th>Сессий</th><th>Среднее</th><th>Мин</th><th>Макс</th><th>Всего</th></tr></thead>
            <tbody>{table_rows}</tbody>
        </table>
        </div>
    </div>
</div>
<script>
const colors = ['#6366f1','#8b5cf6','#a78bfa','#06b6d4','#10b981','#f59e0b','#ef4444',
                '#ec4899','#14b8a6','#84cc16','#f97316','#3b82f6','#e879f9','#22d3ee','#facc15'];
Chart.defaults.color = '#888';
Chart.defaults.borderColor = '#2a2a2a';

new Chart(document.getElementById('avgChart'), {{
    type: 'bar',
    data: {{
        labels: {labels},
        datasets: [{{
            label: 'Среднее (мин)',
            data: {avg_mins},
            backgroundColor: colors,
            borderRadius: 4,
        }}]
    }},
    options: {{
        indexAxis: 'y',
        responsive: true,
        plugins: {{ legend: {{ display: false }} }},
        scales: {{
            x: {{ title: {{ display: true, text: 'минуты' }}, grid: {{ color: '#1a1a1a' }} }},
            y: {{ grid: {{ display: false }} }}
        }}
    }}
}});

new Chart(document.getElementById('compareChart'), {{
    type: 'bar',
    data: {{
        labels: {labels},
        datasets: [
            {{ label: 'Среднее (мин)', data: {avg_mins}, backgroundColor: '#6366f1', borderRadius: 4 }},
            {{ label: 'Макс (мин)', data: {max_mins}, backgroundColor: '#2a2a5a', borderRadius: 4 }}
        ]
    }},
    options: {{
        indexAxis: 'y',
        responsive: true,
        plugins: {{ legend: {{ position: 'top' }} }},
        scales: {{
            x: {{ title: {{ display: true, text: 'минуты' }}, grid: {{ color: '#1a1a1a' }}, stacked: false }},
            y: {{ grid: {{ display: false }} }}
        }}
    }}
}});
</script>
</body>
</html>"""

Path(OUT).write_text(html)
print(f"REPORT_READY:{OUT}")
