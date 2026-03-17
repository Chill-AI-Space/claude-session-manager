"use client";

import { useState, useEffect } from "react";

export function AppearanceSettings() {
  const [fontSize, setFontSize] = useState(100);

  useEffect(() => {
    const saved = localStorage.getItem("fontSizeScale");
    if (saved) setFontSize(parseInt(saved));
  }, []);

  function applyFontSize(scale: number): void {
    setFontSize(scale);
    localStorage.setItem("fontSizeScale", scale.toString());
    document.documentElement.style.fontSize = `${(scale / 100) * 16}px`;
  }

  return (
    <div className="space-y-6">
      <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
        Appearance
      </h2>

      <div className="space-y-3">
        <div className="text-sm font-medium">Font size</div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground w-6 text-right">A</span>
          <input
            type="range"
            min={80}
            max={120}
            step={5}
            value={fontSize}
            onChange={(e) => applyFontSize(parseInt(e.target.value))}
            className="flex-1 accent-primary cursor-pointer"
          />
          <span className="text-base text-muted-foreground w-6">A</span>
          <span className="text-xs text-muted-foreground w-10 text-right tabular-nums">
            {fontSize}%
          </span>
          {fontSize !== 100 && (
            <button
              onClick={() => applyFontSize(100)}
              className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
            >
              Reset
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
