/**
 * Cloudflare Worker — debug log collector for Claude Session Manager.
 *
 * POST /  — receives log batches from instances
 * GET  /  — query recent logs (optional ?instance=&level=&limit=)
 * GET  /stream — SSE stream of new logs (TODO: future)
 */

interface Env {
  DB: D1Database;
}

interface LogEntry {
  ts: string;
  level: string;
  source: string;
  message: string;
  data?: Record<string, unknown>;
}

interface LogBatch {
  instance: string;
  entries: LogEntry[];
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS headers for browser access
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (request.method === "POST" && (url.pathname === "/" || url.pathname === "")) {
        return await handleIngest(request, env, corsHeaders);
      }

      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
        return await handleQuery(url, env, corsHeaders);
      }

      if (request.method === "GET" && url.pathname === "/stats") {
        return await handleStats(env, corsHeaders);
      }

      return new Response("Not found", { status: 404 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500, headers: corsHeaders });
    }
  },
};

// ── POST / — ingest log batch ────────────────────────────────────────────────

async function handleIngest(
  request: Request,
  env: Env,
  headers: Record<string, string>
): Promise<Response> {
  const body = (await request.json()) as LogBatch;

  if (!body.instance || !Array.isArray(body.entries) || body.entries.length === 0) {
    return Response.json({ error: "Invalid batch: need instance + entries[]" }, { status: 400, headers });
  }

  // Batch insert (D1 supports batch)
  const stmt = env.DB.prepare(
    "INSERT INTO logs (ts, instance, level, source, message, data) VALUES (?, ?, ?, ?, ?, ?)"
  );

  const stmts = body.entries.map((e) =>
    stmt.bind(
      e.ts,
      body.instance,
      e.level,
      e.source,
      e.message,
      e.data ? JSON.stringify(e.data) : null
    )
  );

  await env.DB.batch(stmts);

  return Response.json(
    { ok: true, count: body.entries.length },
    { headers }
  );
}

// ── GET / — query logs ───────────────────────────────────────────────────────

async function handleQuery(
  url: URL,
  env: Env,
  headers: Record<string, string>
): Promise<Response> {
  const instance = url.searchParams.get("instance");
  const level = url.searchParams.get("level");
  const source = url.searchParams.get("source");
  const since = url.searchParams.get("since"); // ISO timestamp
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100"), 1000);

  let query = "SELECT * FROM logs WHERE 1=1";
  const params: unknown[] = [];

  if (instance) {
    query += " AND instance = ?";
    params.push(instance);
  }
  if (level) {
    query += " AND level = ?";
    params.push(level);
  }
  if (source) {
    query += " AND source = ?";
    params.push(source);
  }
  if (since) {
    query += " AND ts >= ?";
    params.push(since);
  }

  query += " ORDER BY ts DESC LIMIT ?";
  params.push(limit);

  const result = await env.DB.prepare(query).bind(...params).all();

  return Response.json(
    { logs: result.results, count: result.results.length },
    { headers }
  );
}

// ── GET /stats — instance summary ────────────────────────────────────────────

async function handleStats(
  env: Env,
  headers: Record<string, string>
): Promise<Response> {
  const result = await env.DB.prepare(`
    SELECT
      instance,
      COUNT(*) as total,
      SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) as errors,
      SUM(CASE WHEN level = 'warn' THEN 1 ELSE 0 END) as warns,
      MIN(ts) as first_seen,
      MAX(ts) as last_seen
    FROM logs
    GROUP BY instance
    ORDER BY last_seen DESC
  `).all();

  return Response.json({ instances: result.results }, { headers });
}
