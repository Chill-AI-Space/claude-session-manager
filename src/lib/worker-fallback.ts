/**
 * Worker Fallback — executes fallback chain when a worker goes offline.
 *
 * Chain: Worker offline → Vertex AI / Anthropic API → Email notification → "expert required"
 *
 * Also handles email sending for completed tasks (happy path).
 */
import { getDb, getSetting, logAction } from "./db";
import { getWorkerRegistry, type WorkerTaskRow } from "./worker-registry";
import * as dlog from "./debug-logger";

// ── Fallback chain ──────────────────────────────────────────────────────────

export async function triggerFallback(workerId: string): Promise<void> {
  const registry = getWorkerRegistry();
  const worker = registry.getWorker(workerId);
  if (!worker) {
    dlog.warn("worker-fallback", `worker ${workerId} not found, skipping fallback`);
    return;
  }

  if (getSetting("worker_fallback_enabled") !== "true") {
    dlog.info("worker-fallback", `fallback disabled, skipping for ${workerId}`);
    return;
  }

  // Get pending tasks for this worker
  const pendingTasks = registry.getPendingTasks(workerId);
  if (pendingTasks.length === 0) {
    dlog.info("worker-fallback", `no pending tasks for ${workerId}, nothing to fall back`);
    return;
  }

  dlog.info("worker-fallback", `triggering fallback for ${workerId}: ${pendingTasks.length} pending tasks`);
  logAction("service", "worker_fallback_started", `tasks:${pendingTasks.length}`, workerId);

  registry.setPhase(workerId, "fallback_vertex");

  for (const task of pendingTasks) {
    try {
      // Step 1: Try AI fallback
      const aiResult = await callAIFallback(task);

      if (aiResult) {
        // AI succeeded — update task and send email
        updateTaskStatus(task.task_id, "fallback_vertex", aiResult);
        logAction("service", "worker_fallback_vertex_success", task.task_id, workerId);

        if (task.contact_email) {
          await sendEmail({
            to: task.contact_email,
            subject: `Research complete: ${task.task_id}`,
            body: aiResult,
          });
        }
        continue;
      }
    } catch (err) {
      dlog.error("worker-fallback", `AI fallback failed for task ${task.task_id}: ${err}`);
    }

    // Step 2: AI failed — send "expert will respond" notification
    try {
      registry.setPhase(workerId, "fallback_notify");
      updateTaskStatus(task.task_id, "fallback_notify", null);

      const notifyTo = task.contact_email || getSetting("worker_notify_to");
      if (notifyTo) {
        await sendEmail({
          to: notifyTo,
          subject: `[${worker.projectDomain}] Expert review needed — ${task.task_id}`,
          body: buildExpertNeededEmail(worker.projectDomain, task),
        });
        logAction("service", "worker_fallback_notify_sent", task.task_id, workerId);
      }

      // Also send webhook if configured
      await sendWebhook({
        event: "worker_fallback",
        workerId,
        projectDomain: worker.projectDomain,
        taskId: task.task_id,
        taskPrompt: task.task_prompt,
        message: "Expert review needed — worker offline, AI fallback failed",
      });
    } catch (err) {
      dlog.error("worker-fallback", `notify failed for task ${task.task_id}: ${err}`);
      updateTaskStatus(task.task_id, "failed", null);
    }
  }

  // Set final phase
  const finalTasks = registry.getPendingTasks(workerId);
  if (finalTasks.length === 0) {
    registry.setPhase(workerId, "offline");
  }
}

// ── AI Fallback (Anthropic API) ──────────────────────────────────────────────

async function callAIFallback(task: WorkerTaskRow): Promise<string | null> {
  if (!task.task_prompt) {
    dlog.warn("worker-fallback", `task ${task.task_id} has no prompt, cannot run AI fallback`);
    return null;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    dlog.warn("worker-fallback", "ANTHROPIC_API_KEY not set, skipping AI fallback");
    return null;
  }

  const useVertex = getSetting("worker_fallback_use_vertex") === "true";
  const model = getSetting("worker_fallback_model") || "claude-sonnet-4-6";

  let url: string;
  const headers: Record<string, string> = { "content-type": "application/json" };

  if (useVertex) {
    const project = getSetting("worker_fallback_vertex_project");
    const region = getSetting("worker_fallback_vertex_region") || "us-east5";
    if (!project) {
      dlog.warn("worker-fallback", "Vertex project not configured");
      return null;
    }
    url = `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/publishers/anthropic/models/${model}:streamRawPredict`;
    // Vertex uses OAuth, not API key — would need google-auth-library
    // For now, fall through to direct API
    dlog.warn("worker-fallback", "Vertex AI auth not implemented, using direct API");
    url = "https://api.anthropic.com/v1/messages";
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    url = "https://api.anthropic.com/v1/messages";
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{
          role: "user",
          content: task.task_prompt,
        }],
      }),
      signal: AbortSignal.timeout(120_000), // 2 min timeout
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "unknown");
      dlog.error("worker-fallback", `AI API error ${response.status}: ${errText.slice(0, 200)}`);
      return null;
    }

    const json = await response.json();
    const text = json.content
      ?.filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("\n");

    return text || null;
  } catch (err) {
    dlog.error("worker-fallback", `AI call failed: ${err}`);
    return null;
  }
}

// ── Email ────────────────────────────────────────────────────────────────────

interface EmailParams {
  to: string;
  subject: string;
  body: string;
}

export async function sendEmail(params: EmailParams): Promise<boolean> {
  const { to, subject, body } = params;

  // Try nodemailer (SMTP)
  const smtpHost = getSetting("worker_notify_smtp_host");
  if (smtpHost) {
    return sendViaSMTP(params);
  }

  // Try webhook
  const webhookUrl = getSetting("worker_notify_webhook_url");
  if (webhookUrl) {
    return sendWebhook({ event: "email", to, subject, body });
  }

  dlog.warn("worker-fallback", `no email transport configured, email to ${to} not sent`);
  logAction("service", "worker_email_skipped", `to:${to} subj:${subject.slice(0, 50)}`);
  return false;
}

async function sendViaSMTP(params: EmailParams): Promise<boolean> {
  try {
    // Dynamic import — nodemailer is optional
    const nodemailer = await import("nodemailer");

    const transporter = nodemailer.default.createTransport({
      host: getSetting("worker_notify_smtp_host"),
      port: parseInt(getSetting("worker_notify_smtp_port") || "587", 10),
      secure: getSetting("worker_notify_smtp_port") === "465",
      auth: {
        user: getSetting("worker_notify_smtp_user"),
        pass: getSetting("worker_notify_smtp_pass"),
      },
    });

    await transporter.sendMail({
      from: getSetting("worker_notify_from") || getSetting("worker_notify_smtp_user"),
      to: params.to,
      subject: params.subject,
      text: params.body,
    });

    dlog.info("worker-fallback", `email sent to ${params.to}: ${params.subject}`);
    logAction("service", "worker_email_sent", `to:${params.to}`);
    return true;
  } catch (err) {
    dlog.error("worker-fallback", `SMTP send failed: ${err}`);
    return false;
  }
}

// ── Webhook ──────────────────────────────────────────────────────────────────

async function sendWebhook(payload: Record<string, unknown>): Promise<boolean> {
  const url = getSetting("worker_notify_webhook_url");
  if (!url) return false;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, ts: new Date().toISOString() }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      dlog.warn("worker-fallback", `webhook returned ${res.status}`);
      return false;
    }

    dlog.info("worker-fallback", `webhook sent: ${payload.event}`);
    return true;
  } catch (err) {
    dlog.error("worker-fallback", `webhook failed: ${err}`);
    return false;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function updateTaskStatus(taskId: string, status: string, resultSummary: string | null): void {
  try {
    getDb()
      .prepare(
        `UPDATE worker_tasks SET status = ?, fallback_used = ?, result_summary = ?, completed_at = datetime('now')
         WHERE task_id = ?`
      )
      .run(status, status.startsWith("fallback_") ? status : null, resultSummary?.slice(0, 5000) || null, taskId);
  } catch (err) {
    dlog.error("worker-fallback", `task status update failed: ${err}`);
  }
}

function buildExpertNeededEmail(domain: string, task: WorkerTaskRow): string {
  return [
    `Worker for ${domain} went offline.`,
    ``,
    `Task: ${task.task_id}`,
    `Prompt: ${task.task_prompt?.slice(0, 500) || "(no prompt)"}`,
    `Dispatched: ${task.dispatched_at}`,
    ``,
    `AI fallback was attempted but failed. An expert should review this task.`,
    `Please respond within 1 hour.`,
  ].join("\n");
}
