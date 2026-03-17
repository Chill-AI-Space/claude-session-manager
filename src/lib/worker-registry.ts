/**
 * Worker Registry — manages external workers that process tasks for specific domains.
 *
 * Workers (e.g. research-worker.sh polling Firestore) register via API,
 * send heartbeats, and report task completions. If a worker goes offline
 * (heartbeat missed), the registry emits events so fallback can trigger.
 *
 * Singleton via globalThis (survives Next.js hot reload).
 */
import { EventEmitter } from "events";
import { getDb, getSetting, logAction } from "./db";
import * as dlog from "./debug-logger";

// ── Types ────────────────────────────────────────────────────────────────────

export type WorkerPhase =
  | "online"
  | "offline"
  | "fallback_vertex"
  | "fallback_notify"
  | "failed";

export interface WorkerState {
  workerId: string;
  projectDomain: string;
  phase: WorkerPhase;
  registeredAt: number;
  lastHeartbeatAt: number;
  heartbeatIntervalMs: number;
  missedHeartbeats: number;
  pendingTaskIds: string[];
  meta: Record<string, unknown>;
}

export interface WorkerTaskRow {
  id: number;
  worker_id: string;
  task_id: string;
  project_domain: string;
  status: "pending" | "completed" | "fallback_vertex" | "fallback_notify" | "failed";
  task_prompt: string | null;
  dispatched_at: string;
  completed_at: string | null;
  fallback_used: string | null;
  result_summary: string | null;
  contact_email: string | null;
}

// ── WorkerRegistry ───────────────────────────────────────────────────────────

class WorkerRegistry extends EventEmitter {
  private workers = new Map<string, WorkerState>();
  private heartbeatTimers = new Map<string, NodeJS.Timeout>();

  constructor() {
    super();
    this.setMaxListeners(30);
    this.restoreFromDb();
  }

  /** Restore workers from DB on startup and re-arm timers */
  private restoreFromDb(): void {
    try {
      const db = getDb();
      const rows = db
        .prepare("SELECT * FROM workers WHERE phase = 'online'")
        .all() as Array<{
          worker_id: string;
          project_domain: string;
          phase: string;
          registered_at: string;
          last_heartbeat_at: string | null;
          heartbeat_interval_ms: number;
          missed_heartbeats: number;
          meta: string | null;
        }>;

      const now = Date.now();
      const timeoutMs = parseInt(getSetting("worker_heartbeat_timeout_ms") || "300000", 10);

      for (const row of rows) {
        const lastHb = row.last_heartbeat_at ? new Date(row.last_heartbeat_at).getTime() : 0;
        const state: WorkerState = {
          workerId: row.worker_id,
          projectDomain: row.project_domain,
          phase: "online",
          registeredAt: new Date(row.registered_at).getTime(),
          lastHeartbeatAt: lastHb,
          heartbeatIntervalMs: row.heartbeat_interval_ms,
          missedHeartbeats: row.missed_heartbeats,
          pendingTaskIds: [],
          meta: row.meta ? JSON.parse(row.meta) : {},
        };

        // Load pending tasks
        const tasks = db
          .prepare("SELECT task_id FROM worker_tasks WHERE worker_id = ? AND status = 'pending'")
          .all(row.worker_id) as { task_id: string }[];
        state.pendingTaskIds = tasks.map((t) => t.task_id);

        // Check if heartbeat is stale
        if (now - lastHb > timeoutMs) {
          state.phase = "offline";
          state.missedHeartbeats++;
          this.workers.set(row.worker_id, state);
          this.persistPhase(row.worker_id, "offline", state.missedHeartbeats);
          dlog.info("worker-registry", `worker ${row.worker_id} was offline during restart`);
          this.emit("worker:offline", { workerId: row.worker_id, projectDomain: state.projectDomain });
        } else {
          this.workers.set(row.worker_id, state);
          this.armHeartbeatTimer(row.worker_id, timeoutMs - (now - lastHb));
        }
      }

      if (rows.length > 0) {
        dlog.info("worker-registry", `restored ${rows.length} workers from DB`);
      }
    } catch (err) {
      dlog.error("worker-registry", `restore failed: ${err}`);
    }
  }

  // ── Registration ─────────────────────────────────────────────────────────

  register(params: {
    workerId?: string;
    projectDomain: string;
    heartbeatIntervalMs?: number;
    meta?: Record<string, unknown>;
  }): WorkerState {
    const workerId = params.workerId || `worker-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const heartbeatIntervalMs = params.heartbeatIntervalMs || 30_000;
    const now = Date.now();

    const state: WorkerState = {
      workerId,
      projectDomain: params.projectDomain,
      phase: "online",
      registeredAt: now,
      lastHeartbeatAt: now,
      heartbeatIntervalMs,
      missedHeartbeats: 0,
      pendingTaskIds: [],
      meta: params.meta || {},
    };

    this.workers.set(workerId, state);

    // Persist to DB
    try {
      getDb()
        .prepare(
          `INSERT INTO workers (worker_id, project_domain, phase, registered_at, last_heartbeat_at, heartbeat_interval_ms, meta)
           VALUES (?, ?, 'online', datetime('now'), datetime('now'), ?, ?)
           ON CONFLICT(worker_id) DO UPDATE SET
             project_domain = excluded.project_domain,
             phase = 'online',
             last_heartbeat_at = datetime('now'),
             heartbeat_interval_ms = excluded.heartbeat_interval_ms,
             missed_heartbeats = 0,
             meta = excluded.meta`
        )
        .run(workerId, params.projectDomain, heartbeatIntervalMs, JSON.stringify(params.meta || {}));
    } catch (err) {
      dlog.error("worker-registry", `DB insert failed: ${err}`);
    }

    // Arm heartbeat timer
    const timeoutMs = parseInt(getSetting("worker_heartbeat_timeout_ms") || "300000", 10);
    this.armHeartbeatTimer(workerId, timeoutMs);

    logAction("service", "worker_registered", `${workerId} → ${params.projectDomain}`, workerId);
    this.emit("worker:registered", { workerId, projectDomain: params.projectDomain });

    return state;
  }

  // ── Heartbeat ────────────────────────────────────────────────────────────

  heartbeat(workerId: string, pendingTaskIds?: string[]): { ok: true; nextExpectedMs: number } | { ok: false; error: string } {
    const state = this.workers.get(workerId);
    if (!state) {
      return { ok: false, error: `Worker ${workerId} not registered` };
    }

    state.lastHeartbeatAt = Date.now();
    state.missedHeartbeats = 0;
    state.phase = "online";
    if (pendingTaskIds) {
      state.pendingTaskIds = pendingTaskIds;
    }

    // Update DB
    try {
      getDb()
        .prepare("UPDATE workers SET last_heartbeat_at = datetime('now'), phase = 'online', missed_heartbeats = 0 WHERE worker_id = ?")
        .run(workerId);
    } catch { /* non-critical */ }

    // Re-arm timer
    const timeoutMs = parseInt(getSetting("worker_heartbeat_timeout_ms") || "300000", 10);
    this.armHeartbeatTimer(workerId, timeoutMs);

    this.emit("worker:heartbeat", { workerId });
    return { ok: true, nextExpectedMs: state.heartbeatIntervalMs };
  }

  // ── Task management ──────────────────────────────────────────────────────

  registerTask(params: {
    workerId: string;
    taskId: string;
    taskPrompt: string;
    contactEmail?: string;
  }): boolean {
    const state = this.workers.get(params.workerId);
    if (!state) return false;

    if (!state.pendingTaskIds.includes(params.taskId)) {
      state.pendingTaskIds.push(params.taskId);
    }

    try {
      getDb()
        .prepare(
          `INSERT INTO worker_tasks (worker_id, task_id, project_domain, status, task_prompt, contact_email)
           VALUES (?, ?, ?, 'pending', ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET
             task_prompt = excluded.task_prompt,
             contact_email = excluded.contact_email`
        )
        .run(params.workerId, params.taskId, state.projectDomain, params.taskPrompt, params.contactEmail || null);
    } catch (err) {
      dlog.error("worker-registry", `task insert failed: ${err}`);
      return false;
    }

    logAction("service", "worker_task_registered", `${params.taskId} on ${params.workerId}`);
    return true;
  }

  completeTask(workerId: string, taskId: string, result: {
    summary: string;
    contactEmail?: string;
  }): boolean {
    const state = this.workers.get(workerId);
    if (!state) return false;

    state.pendingTaskIds = state.pendingTaskIds.filter((id) => id !== taskId);

    try {
      getDb()
        .prepare(
          `UPDATE worker_tasks SET status = 'completed', completed_at = datetime('now'), result_summary = ?, contact_email = COALESCE(?, contact_email)
           WHERE task_id = ? AND worker_id = ?`
        )
        .run(result.summary, result.contactEmail || null, taskId, workerId);
    } catch (err) {
      dlog.error("worker-registry", `task complete failed: ${err}`);
      return false;
    }

    logAction("service", "worker_task_completed", `${taskId} on ${workerId}`, workerId);
    this.emit("worker:task_completed", { workerId, taskId, result });
    return true;
  }

  // ── Query ────────────────────────────────────────────────────────────────

  getWorker(workerId: string): WorkerState | null {
    return this.workers.get(workerId) ?? null;
  }

  getAllWorkers(): WorkerState[] {
    return [...this.workers.values()];
  }

  getWorkersByDomain(projectDomain: string): WorkerState[] {
    return this.getAllWorkers().filter((w) => w.projectDomain === projectDomain);
  }

  getPendingTasks(workerId: string): WorkerTaskRow[] {
    try {
      return getDb()
        .prepare("SELECT * FROM worker_tasks WHERE worker_id = ? AND status = 'pending' ORDER BY dispatched_at")
        .all(workerId) as WorkerTaskRow[];
    } catch {
      return [];
    }
  }

  getAllTasks(opts?: { workerId?: string; status?: string; limit?: number }): WorkerTaskRow[] {
    const { workerId, status, limit = 100 } = opts || {};
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (workerId) { conditions.push("worker_id = ?"); params.push(workerId); }
    if (status) { conditions.push("status = ?"); params.push(status); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);

    try {
      return getDb()
        .prepare(`SELECT * FROM worker_tasks ${where} ORDER BY dispatched_at DESC LIMIT ?`)
        .all(...params) as WorkerTaskRow[];
    } catch {
      return [];
    }
  }

  // ── Unregister ───────────────────────────────────────────────────────────

  unregister(workerId: string): boolean {
    const timer = this.heartbeatTimers.get(workerId);
    if (timer) {
      clearTimeout(timer);
      this.heartbeatTimers.delete(workerId);
    }

    const had = this.workers.delete(workerId);

    try {
      getDb().prepare("UPDATE workers SET phase = 'offline' WHERE worker_id = ?").run(workerId);
    } catch { /* non-critical */ }

    if (had) {
      logAction("service", "worker_unregistered", workerId);
      this.emit("worker:unregistered", { workerId });
    }
    return had;
  }

  // ── Update phase (used by fallback module) ───────────────────────────────

  setPhase(workerId: string, phase: WorkerPhase): void {
    const state = this.workers.get(workerId);
    if (state) {
      state.phase = phase;
      this.persistPhase(workerId, phase, state.missedHeartbeats);
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private armHeartbeatTimer(workerId: string, timeoutMs: number): void {
    const existing = this.heartbeatTimers.get(workerId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.heartbeatTimers.delete(workerId);
      this.onHeartbeatTimeout(workerId);
    }, timeoutMs);
    timer.unref();

    this.heartbeatTimers.set(workerId, timer);
  }

  private onHeartbeatTimeout(workerId: string): void {
    const state = this.workers.get(workerId);
    if (!state) return;

    // Prevent re-trigger if already in fallback
    if (state.phase === "fallback_vertex" || state.phase === "fallback_notify" || state.phase === "failed") {
      return;
    }

    state.phase = "offline";
    state.missedHeartbeats++;
    this.persistPhase(workerId, "offline", state.missedHeartbeats);

    logAction("service", "worker_heartbeat_timeout", `missed:${state.missedHeartbeats}`, workerId);
    dlog.warn("worker-registry", `worker ${workerId} heartbeat timeout (missed: ${state.missedHeartbeats})`);

    this.emit("worker:offline", {
      workerId,
      projectDomain: state.projectDomain,
      missedHeartbeats: state.missedHeartbeats,
      pendingTaskIds: [...state.pendingTaskIds],
    });
  }

  private persistPhase(workerId: string, phase: string, missedHeartbeats: number): void {
    try {
      getDb()
        .prepare("UPDATE workers SET phase = ?, missed_heartbeats = ? WHERE worker_id = ?")
        .run(phase, missedHeartbeats, workerId);
    } catch { /* non-critical */ }
  }

  destroy(): void {
    for (const timer of this.heartbeatTimers.values()) {
      clearTimeout(timer);
    }
    this.heartbeatTimers.clear();
    this.workers.clear();
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

const GLOBAL_KEY = "__workerRegistry";

export function getWorkerRegistry(): WorkerRegistry {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new WorkerRegistry();
    dlog.info("worker-registry", "initialized");
  }
  return g[GLOBAL_KEY] as WorkerRegistry;
}

export type { WorkerRegistry };
