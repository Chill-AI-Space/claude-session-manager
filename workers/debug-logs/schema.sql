-- D1 schema for debug log collector
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  instance TEXT NOT NULL,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);
CREATE INDEX IF NOT EXISTS idx_logs_instance ON logs(instance);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);

-- Auto-cleanup: keep last 7 days (run via cron or manual)
-- DELETE FROM logs WHERE ts < datetime('now', '-7 days');
