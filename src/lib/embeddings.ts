import { getDb, getSetting } from "./db";
import { SessionRow } from "./types";

const EMBEDDING_MODEL = "gemini-embedding-001";

/** Build a short text summary of a session for embedding */
function sessionToText(s: Pick<SessionRow, "project_path" | "custom_name" | "generated_title" | "first_prompt" | "last_message">): string {
  const project = s.project_path.split(/[\\/]/).pop() || "";
  const title = s.custom_name || s.generated_title || "";
  const first = (s.first_prompt || "").slice(0, 500);
  const last = (s.last_message || "").slice(0, 300);
  return `${project} ${title} ${first} ${last}`.trim();
}

/** Call Gemini embedding API for a batch of texts */
async function embedBatch(texts: string[], apiKey: string): Promise<Float32Array[]> {
  const results: Float32Array[] = [];

  // Gemini embedContent only does one at a time; batchEmbedContents does multiple
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${EMBEDDING_MODEL}`,
          content: { parts: [{ text }] },
        })),
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Embedding API error: ${err}`);
  }

  const data = await res.json();
  for (const emb of data.embeddings) {
    results.push(new Float32Array(emb.values));
  }

  return results;
}

/** Cosine similarity between two vectors */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

/** Deserialize embedding from SQLite BLOB */
function blobToFloat32(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** Serialize Float32Array to Buffer for SQLite */
function float32ToBlob(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/** Generate embeddings for all sessions that don't have one yet. Returns count generated. */
export async function generateMissingEmbeddings(): Promise<{ generated: number; error?: string }> {
  const apiKey = getSetting("google_ai_api_key") || process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) return { generated: 0, error: "Google AI API key not configured. Set it in Settings → Deep Search or Summary AI." };

  const db = getDb();
  const sessions = db
    .prepare(
      `SELECT session_id, project_path, custom_name, generated_title, first_prompt, last_message
       FROM sessions WHERE embedding IS NULL AND archived = 0
       ORDER BY modified_at DESC LIMIT 100`
    )
    .all() as Pick<SessionRow, "session_id" | "project_path" | "custom_name" | "generated_title" | "first_prompt" | "last_message">[];

  if (sessions.length === 0) return { generated: 0 };

  const updateStmt = db.prepare("UPDATE sessions SET embedding = ? WHERE session_id = ?");
  let generated = 0;

  // Process in batches of 20 (Gemini batch limit)
  for (let i = 0; i < sessions.length; i += 20) {
    const batch = sessions.slice(i, i + 20);
    const texts = batch.map(sessionToText);

    try {
      const embeddings = await embedBatch(texts, apiKey);
      for (let j = 0; j < batch.length; j++) {
        updateStmt.run(float32ToBlob(embeddings[j]), batch[j].session_id);
        generated++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return { generated, error: msg };
    }
  }

  return { generated };
}

/** Vector search: find top-K sessions most similar to the query */
export async function vectorSearch(
  query: string
): Promise<{ session_id: string; score: number }[]> {
  const apiKey = getSetting("google_ai_api_key") || process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) return [];

  const topK = parseInt(getSetting("vector_search_top_k")) || 20;
  const db = getDb();

  // Embed the query
  const [queryEmbedding] = await embedBatch([query], apiKey);

  // Load all sessions with embeddings
  const rows = db
    .prepare(
      `SELECT session_id, embedding FROM sessions
       WHERE embedding IS NOT NULL AND archived = 0`
    )
    .all() as { session_id: string; embedding: Buffer }[];

  // Compute similarities
  const scored = rows.map((row) => ({
    session_id: row.session_id,
    score: cosineSimilarity(queryEmbedding, blobToFloat32(row.embedding)),
  }));

  // Sort descending and take top K
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
