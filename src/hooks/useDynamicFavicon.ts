"use client";

import { useEffect } from "react";

const CLAUDE_ORANGE = "#E8744F";
const CANVAS_SIZE = 64;
const BORDER_WIDTH = 5;
const BORDER_RADIUS = 14;

/** Draw a rounded rectangle path */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** Render icon image with an orange Claude border onto a canvas data URL */
function renderWithBorder(img: HTMLImageElement): string {
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  const ctx = canvas.getContext("2d")!;

  const inset = BORDER_WIDTH;
  const innerSize = CANVAS_SIZE - inset * 2;
  const innerRadius = Math.max(BORDER_RADIUS - BORDER_WIDTH, 2);

  // Draw the icon clipped to rounded rect (inset from border)
  ctx.save();
  roundRect(ctx, inset, inset, innerSize, innerSize, innerRadius);
  ctx.clip();
  ctx.drawImage(img, inset, inset, innerSize, innerSize);
  ctx.restore();

  // Draw the orange border
  ctx.strokeStyle = CLAUDE_ORANGE;
  ctx.lineWidth = BORDER_WIDTH;
  const half = BORDER_WIDTH / 2;
  roundRect(ctx, half, half, CANVAS_SIZE - BORDER_WIDTH, CANVAS_SIZE - BORDER_WIDTH, BORDER_RADIUS);
  ctx.stroke();

  return canvas.toDataURL("image/png");
}

/**
 * Dynamically swap the browser tab favicon based on the project path.
 * Fetches from /api/projects/icon?path=... adds an orange Claude border,
 * and sets it as the page favicon. Restores the default favicons on unmount.
 */
export function useDynamicFavicon(projectPath: string | undefined) {
  useEffect(() => {
    if (!projectPath) return;

    const href = `/api/projects/icon?path=${encodeURIComponent(projectPath)}`;

    // Collect all existing icon links to hide/restore them
    const existingLinks = Array.from(
      document.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"]')
    ) as HTMLLinkElement[];

    // Store original display values
    const originalDisplay = existingLinks.map((l) => l.style.display);

    // Hide all existing icon links so our dynamic one takes priority
    for (const link of existingLinks) {
      link.setAttribute("data-original-href", link.href);
      link.removeAttribute("href");
    }

    // Create our dynamic favicon link
    const dynamicLink = document.createElement("link");
    dynamicLink.rel = "icon";
    dynamicLink.setAttribute("data-dynamic-favicon", "true");
    document.head.appendChild(dynamicLink);

    // Fetch icon, render with orange border, set as favicon
    const controller = new AbortController();
    fetch(href, { signal: controller.signal })
      .then((res) => res.blob())
      .then((blob) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          dynamicLink.href = renderWithBorder(img);
          URL.revokeObjectURL(img.src);
        };
        img.onerror = () => {
          // Fallback: use icon directly without border
          dynamicLink.href = href;
          URL.revokeObjectURL(img.src);
        };
        img.src = URL.createObjectURL(blob);
      })
      .catch(() => {
        // Fallback: use icon directly
        dynamicLink.href = href;
      });

    return () => {
      controller.abort();
      // Remove our dynamic link
      dynamicLink.remove();

      // Restore original icon links
      existingLinks.forEach((link, i) => {
        const originalHref = link.getAttribute("data-original-href");
        if (originalHref) {
          link.href = originalHref;
          link.removeAttribute("data-original-href");
        }
        link.style.display = originalDisplay[i];
      });
    };
  }, [projectPath]);
}
