import { DEFAULT_CODEX_MODEL, listCodexModels } from "@/lib/codex-models";

export const dynamic = "force-dynamic";

/** Lists the Codex models this machine can run (~/.codex/models_cache.json). */
export async function GET() {
  const models = listCodexModels();

  return Response.json({
    models,
    // What Codex itself defaults to, unless the list can't be read at all —
    // then the caller falls back to the first model it got.
    defaultModel: models[0]?.slug ?? DEFAULT_CODEX_MODEL,
  });
}