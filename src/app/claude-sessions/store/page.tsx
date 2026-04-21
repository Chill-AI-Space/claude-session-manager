"use client";

import { ArrowLeft, Package } from "lucide-react";
import Link from "next/link";
import { EmbeddedStore } from "@/components/store/EmbeddedStore";
import { PLUGINS } from "@/components/store/plugin-data";

export default function StorePage() {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-6">
        <Link
          href="/claude-sessions"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-4"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to sessions
        </Link>

        <div className="flex items-center gap-2 mb-6">
          <Package className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Store</h1>
          <span className="text-xs text-muted-foreground/50">{PLUGINS.length} plugins</span>
        </div>

        <EmbeddedStore />

        <div className="mt-8 text-center">
          <p className="text-xs text-muted-foreground/40">
            More plugins coming soon. Have an idea?{" "}
            <a
              href="https://github.com/Chill-AI-Space"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-muted-foreground"
            >
              Open a feature request
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
