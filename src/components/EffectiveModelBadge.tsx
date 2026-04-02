"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, AlertCircle } from "lucide-react";

export interface EffectiveModelInfo {
  reportedModel: string | null;
  effectiveModel: string;
  isOverridden: boolean;
  provider: string | null;
  label: string;
  shortLabel: string;
}

interface EffectiveModelBadgeProps {
  reportedModel: string | null;
  variant?: "compact" | "full";
}

/**
 * Displays the effective model with override detection.
 *
 * - If no override: shows the model name as-is
 * - If override detected (e.g., ANTHROPIC_BASE_URL pointing to Z.ai):
 *   - Compact: "glm-5.1 (Z.ai)" with link icon
 *   - Full: "claude-sonnet-4-6 → glm-5.1 (Z.ai)" with warning badge
 */
export function EffectiveModelBadge({ reportedModel, variant = "compact" }: EffectiveModelBadgeProps) {
  const [effective, setEffective] = useState<EffectiveModelInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchEffectiveModel = async () => {
      try {
        const url = new URL("/api/model/effective", window.location.origin);
        if (reportedModel) {
          url.searchParams.set("reportedModel", reportedModel);
        }
        const res = await fetch(url.toString());
        if (res.ok) {
          const data = await res.json();
          setEffective(data);
        }
      } catch {
        // Ignore errors, fall back to reported model
      } finally {
        setLoading(false);
      }
    };

    fetchEffectiveModel();
  }, [reportedModel]);

  if (loading || !effective) {
    return <span className="text-xs text-muted-foreground">{reportedModel || "Unknown"}</span>;
  }

  if (!effective.isOverridden) {
    return <span className="text-xs text-muted-foreground">{effective.effectiveModel}</span>;
  }

  // Override detected
  if (variant === "compact") {
    return (
      <div className="flex items-center gap-1.5">
        <Badge variant="secondary" className="text-xs px-2 py-0 h-5 font-normal">
          {effective.shortLabel}
        </Badge>
        {effective.provider === "Z.ai" && (
          <a
            href="https://docs.z.ai/devpack/tool/claude"
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground transition-colors"
            title="Open Z.ai docs"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    );
  }

  // Full variant with override warning
  return (
    <div className="flex items-center gap-2">
      <Badge variant="outline" className="text-xs px-2 py-0 h-5 font-normal">
        {effective.label}
      </Badge>
      {effective.provider && (
        <Badge
          variant="secondary"
          className="text-xs px-2 py-0 h-5 font-normal flex items-center gap-1"
          title={`Model overridden by ANTHROPIC_BASE_URL and ANTHROPIC_DEFAULT_*_MODEL environment variables`}
        >
          <AlertCircle className="h-3 w-3" />
          {effective.provider} proxy
        </Badge>
      )}
      {effective.provider === "Z.ai" && (
        <a
          href="https://docs.z.ai/devpack/tool/claude"
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground hover:text-foreground transition-colors"
          title="Open Z.ai DevPack docs"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}
