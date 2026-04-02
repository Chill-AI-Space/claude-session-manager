/**
 * Detect the effective model by checking environment variables.
 *
 * When users set ANTHROPIC_BASE_URL and ANTHROPIC_DEFAULT_SONNET_MODEL
 * in their shell (e.g., ~/.zshrc), the JSONL may show one model but
 * the actual API calls go through a proxy to a different model.
 *
 * Example (Z.ai GLM 5.1 setup):
 *   ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic"
 *   ANTHROPIC_DEFAULT_SONNET_MODEL="glm-5.1"
 *
 * In this case, even if JSONL shows "claude-sonnet-4-6" or "glm-4.7",
 * the effective model is "glm-5.1 via Z.ai".
 */

export interface EffectiveModel {
  /** The model name as reported in JSONL/session metadata */
  reportedModel: string | null;
  /** The actual model being used (may differ from reported if env vars override) */
  effectiveModel: string;
  /** Whether the model was overridden by environment variables */
  isOverridden: boolean;
  /** The proxy/provider, if any (e.g., "Z.ai") */
  provider: string | null;
}

/**
 * Detect the effective model by checking environment variables.
 * Checks for common proxy setups like Z.ai, AWS Bedrock, etc.
 */
export function detectEffectiveModel(reportedModel: string | null): EffectiveModel {
  const base_url = process.env.ANTHROPIC_BASE_URL || "";
  const default_sonnet = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || "";
  const default_opus = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL || "";
  const default_haiku = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || "";

  // Detect Z.ai proxy
  if (base_url.includes("api.z.ai")) {
    const zaiModel = default_sonnet || default_opus || default_haiku;
    if (zaiModel) {
      return {
        reportedModel,
        effectiveModel: zaiModel,
        isOverridden: true,
        provider: "Z.ai",
      };
    }
  }

  // Detect AWS Bedrock
  if (base_url.includes("bedrock")) {
    const bedrockModel = default_sonnet || default_opus || default_haiku;
    if (bedrockModel) {
      return {
        reportedModel,
        effectiveModel: bedrockModel,
        isOverridden: true,
        provider: "AWS Bedrock",
      };
    }
  }

  // Detect other proxies (Vertex AI, Azure, etc.)
  if (base_url.includes("vertex") || base_url.includes("google")) {
    const vertexModel = default_sonnet || default_opus || default_haiku;
    if (vertexModel) {
      return {
        reportedModel,
        effectiveModel: vertexModel,
        isOverridden: true,
        provider: "Vertex AI",
      };
    }
  }

  // No override detected
  return {
    reportedModel,
    effectiveModel: reportedModel || "unknown",
    isOverridden: false,
    provider: null,
  };
}

/**
 * Get a human-readable label for the effective model.
 * Examples:
 *   "glm-5.1 (Z.ai)"
 *   "claude-sonnet-4-6"
 *   "claude-sonnet-4-6 → glm-5.1 (Z.ai)"
 */
export function getModelLabel(effective: EffectiveModel): string {
  if (!effective.isOverridden) {
    return effective.effectiveModel;
  }

  const reported = effective.reportedModel || "unknown";
  const effectiveWithProvider = effective.provider
    ? `${effective.effectiveModel} (${effective.provider})`
    : effective.effectiveModel;

  return `${reported} → ${effectiveWithProvider}`;
}

/**
 * Get a short label for UI (just the effective model + provider hint).
 * Examples:
 *   "glm-5.1 (Z.ai)"
 *   "claude-sonnet-4-6"
 */
export function getShortModelLabel(effective: EffectiveModel): string {
  if (effective.provider) {
    return `${effective.effectiveModel} (${effective.provider})`;
  }
  return effective.effectiveModel;
}
