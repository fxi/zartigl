import type { Inset } from "../projversor";
import { insetRect, type Rect, type Size } from "./layout";

/** What the layout decided for the current scene and viewport. */
export interface LayoutSnapshot {
  scene: string;
  layout: string;
  variant: string;
  viewport: Size;
  zone: Rect;
  text: Rect;
  inset: Inset;
  outline: readonly [number, number][];
}

/** The text spills out of its zone (1 px tolerance). */
export function overflows(text: Rect, zone: Rect): boolean {
  return (
    text.width > 0 &&
    (text.x < zone.x - 1 ||
      text.y < zone.y - 1 ||
      text.x + text.width > zone.x + zone.width + 1 ||
      text.y + text.height > zone.y + zone.height + 1)
  );
}

const warned = new Set<string>();

/**
 * `?debug` overlay: the text zone (dashed), the measured text (solid, red
 * when it overflows the zone), the map's free zone and the sphere outline.
 */
export function drawLayoutDebug(
  canvas: HTMLCanvasElement,
  snapshot: LayoutSnapshot,
): void {
  const { viewport, zone, text, inset, outline } = snapshot;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(viewport.width * dpr);
  canvas.height = Math.round(viewport.height * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, viewport.width, viewport.height);
  const rect = (r: Rect, color: string, dash: number[] = []) => {
    ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.width - 1, r.height - 1);
  };
  const free = insetRect(viewport, inset);
  ctx.fillStyle = "rgba(80, 255, 160, 0.06)";
  ctx.fillRect(free.x, free.y, free.width, free.height);
  rect(free, "rgba(80, 255, 160, 0.9)", [2, 4]);
  rect(zone, "rgba(120, 200, 255, 0.9)", [6, 4]);
  const spill = overflows(text, zone);
  if (text.width > 0) {
    rect(text, spill ? "#ff4d4d" : "rgba(255, 220, 90, 0.95)");
  }
  if (outline.length > 2) {
    ctx.setLineDash([]);
    ctx.strokeStyle = "rgba(255, 90, 220, 0.9)";
    ctx.beginPath();
    outline.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
  }
  ctx.font = "11px ui-monospace, monospace";
  ctx.fillStyle = spill ? "#ff4d4d" : "rgba(255, 255, 255, 0.85)";
  const label = `${snapshot.scene} · ${snapshot.layout} → ${snapshot.variant} · ${viewport.width}×${viewport.height}${spill ? " · OVERFLOW" : ""}`;
  ctx.fillText(label, 8, viewport.height - 8);
  const key = `${snapshot.scene}:${viewport.width}x${viewport.height}`;
  if (spill && !warned.has(key)) {
    warned.add(key);
    console.warn(`[story layout] text overflows its zone: ${label}`, {
      zone,
      text,
    });
  }
}
