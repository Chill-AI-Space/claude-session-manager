import { NextRequest, NextResponse } from "next/server";
import { detectEffectiveModel, getShortModelLabel, getModelLabel } from "@/lib/model-detector";

export const runtime = "nodejs";

/**
 * GET /api/model/effective?reportedModel=claude-sonnet-4-6
 *
 * Returns the effective model after checking environment overrides.
 * Use this to detect when ANTHROPIC_BASE_URL and ANTHROPIC_DEFAULT_*_MODEL
 * redirect to a different provider (e.g., Z.ai GLM models).
 *
 * Query params:
 *   reportedModel (optional) - The model name from JSONL/session metadata
 *
 * Response:
 *   {
 *     reportedModel: string | null,
 *     effectiveModel: string,
 *     isOverridden: boolean,
 *     provider: string | null,
 *     label: string,          // Human-readable: "claude-sonnet-4-6 → glm-5.1 (Z.ai)"
 *     shortLabel: string      // Compact: "glm-5.1 (Z.ai)"
 *   }
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const reportedModel = searchParams.get("reportedModel");

  const effective = detectEffectiveModel(reportedModel);

  return NextResponse.json({
    ...effective,
    label: getModelLabel(effective),
    shortLabel: getShortModelLabel(effective),
  });
}
