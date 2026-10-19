import type { Inset } from "../projversor";

/**
 * Scene layouts. A gradient layout names the veil direction, from the solid
 * side holding the text to the clear side holding the map: `n-s` puts the
 * text on top and the map below.
 */
export const LAYOUT_IDS = [
  "n-s",
  "s-n",
  "w-e",
  "e-w",
  "nw-se",
  "ne-sw",
  "sw-ne",
  "se-nw",
  "title",
  "end",
  "minimal",
  "none",
] as const;

export type LayoutId = (typeof LAYOUT_IDS)[number];

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Fixed bands of the page: side gutter, masthead on top, dock below. */
export interface LayoutMetrics {
  gutter: number;
  masthead: number;
  dock: number;
  /** Space between the text and the map's free zone. */
  gap: number;
}

export interface ResolvedLayout {
  /** The layout actually drawn for this viewport. */
  variant: LayoutId;
  /** Css gradient angle of the veil (0deg points up), or null for none. */
  angle: number | null;
  align: "start" | "center" | "end";
  /** Edge holding the vertical label: the side away from the text. */
  edge: "left" | "right";
}

export function isLayoutId(value: string): value is LayoutId {
  return (LAYOUT_IDS as readonly string[]).includes(value);
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function layoutMetrics(viewport: Size): LayoutMetrics {
  const gutter = Math.round(clamp(viewport.width * 0.035, 16, 56));
  if (isShortLandscape(viewport)) {
    return { gutter, masthead: 40, dock: 112, gap: 20 };
  }
  const narrow = viewport.width < 640;
  return {
    gutter,
    masthead: narrow ? 48 : 64,
    dock: narrow ? 140 : 132,
    gap: narrow ? 16 : 32,
  };
}

/** Portrait: the text goes on top or below. */
const PORTRAIT: Partial<Record<LayoutId, LayoutId>> = {
  "w-e": "n-s",
  "nw-se": "n-s",
  "ne-sw": "n-s",
  "e-w": "s-n",
  "sw-ne": "s-n",
  "se-nw": "s-n",
};

/** Short landscape (a phone on its side): the text goes beside the map. */
const SHORT: Partial<Record<LayoutId, LayoutId>> = {
  "n-s": "w-e",
  "s-n": "e-w",
  "nw-se": "w-e",
  "sw-ne": "w-e",
  "ne-sw": "e-w",
  "se-nw": "e-w",
  title: "w-e",
  end: "e-w",
};

const ANGLES: Record<LayoutId, number | null> = {
  "n-s": 180,
  "s-n": 0,
  "w-e": 90,
  "e-w": 270,
  "nw-se": 135,
  "ne-sw": 225,
  "sw-ne": 45,
  "se-nw": 315,
  title: 180,
  end: 0,
  minimal: 135,
  none: null,
};

export function isPortrait(viewport: Size): boolean {
  return viewport.width / viewport.height < 0.9;
}

export function isShortLandscape(viewport: Size): boolean {
  return viewport.height < 520 && viewport.width / viewport.height > 1.3;
}

/** The variant drawn for a viewport, its veil angle, alignment and edge. */
export function resolveLayout(id: LayoutId, viewport: Size): ResolvedLayout {
  const variant =
    (isPortrait(viewport)
      ? PORTRAIT[id]
      : isShortLandscape(viewport)
        ? SHORT[id]
        : undefined) ?? id;
  const right = variant === "e-w" || variant === "ne-sw" || variant === "se-nw";
  const centered = variant === "title" || variant === "end";
  return {
    variant,
    angle: ANGLES[variant],
    align: centered ? "center" : right ? "end" : "start",
    edge: right ? "left" : "right",
  };
}

/**
 * The largest box the text of a variant may take. The copy is laid out in
 * it, and its measured box (never larger) sets the map's free zone.
 */
export function textZone(
  variant: LayoutId,
  viewport: Size,
  metrics: LayoutMetrics = layoutMetrics(viewport),
): Rect {
  const { width: W, height: H } = viewport;
  const { gutter: g, masthead: top, dock } = metrics;
  const portrait = isPortrait(viewport);
  const inner = W - 2 * g;
  const bottom = H - dock;
  const side = Math.round(clamp(W * 0.36, 300, 560));
  const corner = Math.round(clamp(W * 0.34, 300, 520));
  switch (variant) {
    case "n-s":
    case "title": {
      const width = Math.min(inner, variant === "title" ? 960 : 1180);
      const height = Math.round(H * (portrait ? 0.4 : 0.36));
      return { x: (W - width) / 2, y: top, width, height };
    }
    case "s-n":
    case "end": {
      const width = Math.min(inner, variant === "end" ? 960 : 1180);
      const height = Math.round(H * (portrait ? 0.38 : 0.34));
      return { x: (W - width) / 2, y: bottom - height, width, height };
    }
    case "w-e":
      return { x: g, y: top, width: side, height: bottom - top };
    case "e-w":
      return { x: W - g - side, y: top, width: side, height: bottom - top };
    case "nw-se":
    case "ne-sw": {
      const height = Math.round((bottom - top) * 0.55);
      const x = variant === "nw-se" ? g : W - g - corner;
      return { x, y: top, width: corner, height };
    }
    case "sw-ne":
    case "se-nw": {
      const height = Math.round((bottom - top) * 0.55);
      const x = variant === "sw-ne" ? g : W - g - corner;
      return { x, y: bottom - height, width: corner, height };
    }
    case "minimal": {
      const width = portrait ? inner : Math.round(clamp(W * 0.28, 280, 380));
      const height = Math.round(Math.max(H * 0.24, 170));
      return { x: g, y: top, width, height };
    }
    case "none":
      return { x: g, y: top, width: 0, height: 0 };
  }
}

/**
 * Free zone of the map around the measured text box: the sphere is centered
 * and fitted beside the text, on the clear side of the veil. A corner text
 * keeps whichever split leaves the larger zone.
 */
export function mapInset(
  variant: LayoutId,
  viewport: Size,
  text: Rect,
  metrics: LayoutMetrics = layoutMetrics(viewport),
): Inset {
  const { width: W, height: H } = viewport;
  const { gap } = metrics;
  const none: Inset = { top: 0, right: 0, bottom: 0, left: 0 };
  if (variant === "none" || text.width <= 0 || text.height <= 0) {
    return none;
  }
  const below = { ...none, top: text.y + text.height + gap };
  const above = { ...none, bottom: H - text.y + gap };
  const right = { ...none, left: text.x + text.width + gap };
  const left = { ...none, right: W - text.x + gap };
  const area = (inset: Inset) =>
    Math.max(0, W - inset.left - inset.right) *
    Math.max(0, H - inset.top - inset.bottom);
  const larger = (a: Inset, b: Inset) => (area(a) >= area(b) ? a : b);
  switch (variant) {
    case "n-s":
    case "title":
      return below;
    case "s-n":
    case "end":
      return above;
    case "w-e":
      return right;
    case "e-w":
      return left;
    case "nw-se":
    case "minimal":
      return larger(below, right);
    case "ne-sw":
      return larger(below, left);
    case "sw-ne":
      return larger(above, right);
    case "se-nw":
      return larger(above, left);
  }
}

/** The zone left to the map by an inset. */
export function insetRect(viewport: Size, inset: Inset): Rect {
  return {
    x: inset.left,
    y: inset.top,
    width: Math.max(0, viewport.width - inset.left - inset.right),
    height: Math.max(0, viewport.height - inset.top - inset.bottom),
  };
}

/**
 * Veil stops, in % of the css gradient line: solid until the far corner of
 * the text box, then a fade over `fade` of the line.
 */
export function veilStops(
  angle: number,
  viewport: Size,
  text: Rect,
  fade = 0.26,
): { solid: number; clear: number } {
  const { width: W, height: H } = viewport;
  const rad = (angle * Math.PI) / 180;
  // Css gradients: 0deg points up, 90deg right; the line spans the box.
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const length = Math.abs(W * dx) + Math.abs(H * dy);
  const corners: [number, number][] = [
    [text.x, text.y],
    [text.x + text.width, text.y],
    [text.x, text.y + text.height],
    [text.x + text.width, text.y + text.height],
  ];
  const reach = Math.max(
    ...corners.map(
      ([x, y]) => ((x - W / 2) * dx + (y - H / 2) * dy) / length + 0.5,
    ),
  );
  const solid = clamp(reach, 0, 1);
  return {
    solid: Math.round(solid * 1000) / 10,
    clear: Math.round(clamp(solid + fade, 0, 1) * 1000) / 10,
  };
}

/** Area shared by two boxes. */
export function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return Math.max(0, w) * Math.max(0, h);
}

/**
 * Css `shape-outside` polygon for a float that spans `box` (css px of the
 * page) on the map side of the text: the sphere outline's near limb, sampled
 * every `step` px, so the lines of the paragraph stop at the globe's edge.
 * `side` is where the map lies. Null when the outline does not enter the box.
 */
export function limbShape(
  outline: readonly [number, number][],
  box: Rect,
  side: "left" | "right",
  step = 8,
): string | null {
  if (outline.length < 3 || box.width <= 0 || box.height <= 0) {
    return null;
  }
  const points: string[] = [];
  let enters = false;
  for (let y = 0; y <= box.height; y += step) {
    const py = box.y + y;
    // Crossings of the outline at this height.
    const xs: number[] = [];
    for (let i = 0; i < outline.length; i++) {
      const [x0, y0] = outline[i];
      const [x1, y1] = outline[(i + 1) % outline.length];
      if (y0 === y1 || py < Math.min(y0, y1) || py >= Math.max(y0, y1)) {
        continue;
      }
      xs.push(x0 + ((py - y0) / (y1 - y0)) * (x1 - x0));
    }
    const near = xs.length
      ? side === "right"
        ? Math.min(...xs)
        : Math.max(...xs)
      : side === "right"
        ? box.x + box.width
        : box.x;
    const local = Math.min(box.width, Math.max(0, near - box.x));
    if (side === "right" ? local < box.width : local > 0) {
      enters = true;
    }
    points.push(`${Math.round(local)}px ${Math.round(y)}px`);
  }
  if (!enters) {
    return null;
  }
  const edge = side === "right" ? `${box.width}px` : "0px";
  return `polygon(${edge} 0px, ${points.join(", ")}, ${edge} ${box.height}px)`;
}
