/**
 * The three orthogonal sections of the month, drawn with Canvas2D from the
 * resampled volume: TOP (longitude × latitude at the depth cursor), EQ
 * (longitude × depth at the latitude cursor, the classic thermocline
 * section) and SIDE (latitude × depth at the longitude cursor). Each one
 * shows the other cursors, the ROI, optional isotherms, the value under the
 * pointer, and sets its two cursors on click or drag.
 */

import { contours } from "d3";
import { NINO34, latLabel, lonLabel } from "../data/box";
import type { Volume } from "../data/blocks";
import { rampColor } from "../palettes";
import { BOTTOM, type Space } from "../gl/space";
import type { Polyline } from "./coast";

export type SliceKind = "top" | "eq" | "side";

export interface Cursor {
  lon: number;
  lat: number;
  depth: number;
}

export interface SliceStyle {
  ramp: Uint8Array;
  domain: [number, number];
  contours: boolean;
  roi: boolean;
  coast: boolean;
}

const FONT = '10px "IBM Plex Mono", ui-monospace, monospace';
const MARGIN = { left: 44, right: 10, top: 8, bottom: 22 };
const ISO_STEP = 2;
const ISO_MAIN = 20;

interface Axis {
  /** Data coordinate at the plot's left/top and right/bottom edges. */
  from: number;
  to: number;
  ticks: number[];
  label: (value: number) => string;
}

export class SlicePanel {
  readonly canvas: HTMLCanvasElement;
  private image = document.createElement("canvas");
  private volume: Volume | null = null;
  private cursor: Cursor = { lon: 220, lat: 0, depth: 50 };
  private style: SliceStyle | null = null;
  private hover: [number, number] | null = null;

  constructor(
    readonly kind: SliceKind,
    private space: Space,
    private coast: Polyline[],
    private readout: HTMLElement,
    private onPick: (cursor: Partial<Cursor>) => void,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "slice-canvas";
    let dragging = false;
    const pick = (event: PointerEvent) => {
      const point = this.toData(event.offsetX, event.offsetY);
      if (!point) {
        return;
      }
      const [a, b] = point;
      if (kind === "top") {
        onPick({ lon: a, lat: b });
      } else if (kind === "eq") {
        onPick({ lon: a, depth: b });
      } else {
        onPick({ lat: a, depth: b });
      }
    };
    this.canvas.addEventListener("pointerdown", (event) => {
      dragging = true;
      this.canvas.setPointerCapture(event.pointerId);
      pick(event);
    });
    this.canvas.addEventListener("pointermove", (event) => {
      this.hover = [event.offsetX, event.offsetY];
      if (dragging) {
        pick(event);
      }
      this.updateReadout();
    });
    this.canvas.addEventListener("pointerup", () => (dragging = false));
    this.canvas.addEventListener("pointerleave", () => {
      this.hover = null;
      this.updateReadout();
    });
  }

  /** Horizontal and vertical axes of this section. */
  private axes(): [Axis, Axis] {
    const { space } = this;
    const lonAxis: Axis = {
      from: space.west,
      to: space.east,
      ticks: [140, 160, 180, 200, 220, 240, 260],
      label: (v) => lonLabel(v),
    };
    const latAxis: Axis = {
      from: space.north,
      to: space.south,
      ticks: [10, 5, 0, -5, -10],
      label: (v) => latLabel(v),
    };
    const latAcross: Axis = { ...latAxis, from: space.south, to: space.north };
    const depthAxis: Axis = {
      from: 0,
      to: BOTTOM,
      ticks: [0, 50, 100, 150, 200, 250, 300],
      label: (v) => `${v}`,
    };
    if (this.kind === "top") {
      return [lonAxis, latAxis];
    }
    return [this.kind === "eq" ? lonAxis : latAcross, depthAxis];
  }

  private plot(): { x: number; y: number; w: number; h: number } {
    const ratio = window.devicePixelRatio || 1;
    const w = this.canvas.width / ratio;
    const h = this.canvas.height / ratio;
    return {
      x: MARGIN.left,
      y: MARGIN.top,
      w: Math.max(1, w - MARGIN.left - MARGIN.right),
      h: Math.max(1, h - MARGIN.top - MARGIN.bottom),
    };
  }

  /** Data coordinates under a CSS pixel of the canvas, or null outside the plot. */
  private toData(px: number, py: number): [number, number] | null {
    const plot = this.plot();
    const fx = (px - plot.x) / plot.w;
    const fy = (py - plot.y) / plot.h;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) {
      return null;
    }
    const [h, v] = this.axes();
    return [h.from + fx * (h.to - h.from), v.from + fy * (v.to - v.from)];
  }

  private toPixel(a: number, b: number): [number, number] {
    const plot = this.plot();
    const [h, v] = this.axes();
    return [
      plot.x + ((a - h.from) / (h.to - h.from)) * plot.w,
      plot.y + ((b - v.from) / (v.to - v.from)) * plot.h,
    ];
  }

  /** Index of the grid cell nearest a value on an evenly spaced axis of n cells. */
  private static cell(
    value: number,
    from: number,
    to: number,
    n: number,
  ): number {
    return Math.max(
      0,
      Math.min(n - 1, Math.floor(((value - from) / (to - from)) * n)),
    );
  }

  /** The section as a row-major grid (first row at the top) and its size. */
  private grid(): {
    values: Float32Array;
    width: number;
    height: number;
  } | null {
    const volume = this.volume;
    if (!volume) {
      return null;
    }
    const { cols, rows, steps, values } = volume;
    const { space, cursor } = this;
    const plane = cols * rows;
    if (this.kind === "top") {
      const step = Math.round((cursor.depth / BOTTOM) * (steps - 1));
      const out = new Float32Array(plane);
      for (let r = 0; r < rows; r++) {
        // North at the top.
        out.set(
          values.subarray(
            step * plane + (rows - 1 - r) * cols,
            step * plane + (rows - r) * cols,
          ),
          r * cols,
        );
      }
      return { values: out, width: cols, height: rows };
    }
    if (this.kind === "eq") {
      const row = SlicePanel.cell(cursor.lat, space.south, space.north, rows);
      const out = new Float32Array(cols * steps);
      for (let s = 0; s < steps; s++) {
        out.set(
          values.subarray(s * plane + row * cols, s * plane + (row + 1) * cols),
          s * cols,
        );
      }
      return { values: out, width: cols, height: steps };
    }
    const col = SlicePanel.cell(cursor.lon, space.west, space.east, cols);
    const out = new Float32Array(rows * steps);
    for (let s = 0; s < steps; s++) {
      for (let r = 0; r < rows; r++) {
        out[s * rows + r] = values[s * plane + r * cols + col];
      }
    }
    return { values: out, width: rows, height: steps };
  }

  /** The value under the pointer, as text. */
  private updateReadout(): void {
    const title = this.title();
    const point = this.hover ? this.toData(...this.hover) : null;
    const grid = point ? this.grid() : null;
    if (!point || !grid) {
      this.readout.textContent = title;
      return;
    }
    const [h, v] = this.axes();
    const col = SlicePanel.cell(point[0], h.from, h.to, grid.width);
    // Latitude rows are cells; depth rows are samples at exact depths.
    const row =
      this.kind === "top"
        ? SlicePanel.cell(point[1], v.from, v.to, grid.height)
        : Math.max(
            0,
            Math.min(
              grid.height - 1,
              Math.round(
                ((point[1] - v.from) / (v.to - v.from)) * (grid.height - 1),
              ),
            ),
          );
    const value = grid.values[row * grid.width + col];
    const where =
      this.kind === "top"
        ? `${lonLabel(point[0], 1)} ${latLabel(point[1], 1)}`
        : this.kind === "eq"
          ? `${lonLabel(point[0], 1)} ${Math.round(point[1])} m`
          : `${latLabel(point[0], 1)} ${Math.round(point[1])} m`;
    this.readout.textContent = `${title} · ${where} · ${Number.isNaN(value) ? "—" : `${value.toFixed(2)} °C`}`;
  }

  title(): string {
    const { cursor } = this;
    if (this.kind === "top") {
      return `TOP (Z = ${Math.round(cursor.depth)} m)`;
    }
    if (this.kind === "eq") {
      return `SECTION (Y = ${latLabel(cursor.lat, 1)})`;
    }
    return `SIDE (X = ${lonLabel(cursor.lon, 1)})`;
  }

  update(volume: Volume | null, cursor: Cursor, style: SliceStyle): void {
    this.volume = volume;
    this.cursor = cursor;
    this.style = style;
    this.draw();
    this.updateReadout();
  }

  resize(): void {
    const ratio = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.round(rect.height * ratio));
    this.draw();
  }

  draw(): void {
    const ctx = this.canvas.getContext("2d")!;
    const ratio = window.devicePixelRatio || 1;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const plot = this.plot();
    const grid = this.grid();
    const style = this.style;
    if (grid && style) {
      this.image.width = grid.width;
      this.image.height = grid.height;
      const image = this.image.getContext("2d")!;
      const pixels = image.createImageData(grid.width, grid.height);
      const [low, high] = style.domain;
      grid.values.forEach((value, i) => {
        if (Number.isNaN(value)) {
          pixels.data.set([33, 34, 36, 255], i * 4);
          return;
        }
        const [r, g, b] = rampColor(style.ramp, (value - low) / (high - low));
        pixels.data.set([r, g, b, 255], i * 4);
      });
      image.putImageData(pixels, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.image, plot.x, plot.y, plot.w, plot.h);
      if (style.contours) {
        this.drawContours(ctx, grid, plot);
      }
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, plot.y, plot.w, plot.h);
    ctx.clip();
    if (this.kind === "top" && style?.coast) {
      ctx.strokeStyle = "rgba(240, 242, 245, 0.85)";
      ctx.lineWidth = 0.8;
      for (const line of this.coast) {
        ctx.beginPath();
        line.forEach(([lon, lat], i) => {
          const [x, y] = this.toPixel(lon, lat);
          if (i) {
            ctx.lineTo(x, y);
          } else {
            ctx.moveTo(x, y);
          }
        });
        ctx.stroke();
      }
    }
    if (style?.roi) {
      this.drawRoi(ctx);
    }
    this.drawCursors(ctx, plot);
    ctx.restore();
    this.drawAxes(ctx, plot);
  }

  private drawContours(
    ctx: CanvasRenderingContext2D,
    grid: { values: Float32Array; width: number; height: number },
    plot: { x: number; y: number; w: number; h: number },
  ): void {
    const filled = Array.from(grid.values, (value) =>
      Number.isNaN(value) ? -1e3 : value,
    );
    const thresholds: number[] = [];
    for (let t = 2; t <= 32; t += ISO_STEP) {
      thresholds.push(t);
    }
    const sx = plot.w / grid.width;
    const sy = plot.h / grid.height;
    for (const contour of contours()
      .size([grid.width, grid.height])
      .thresholds(thresholds)(filled)) {
      const main = contour.value === ISO_MAIN;
      ctx.strokeStyle = main
        ? "rgba(255, 255, 255, 0.95)"
        : "rgba(255, 255, 255, 0.35)";
      ctx.lineWidth = main ? 1.4 : 0.6;
      ctx.beginPath();
      for (const polygon of contour.coordinates) {
        for (const ring of polygon) {
          ring.forEach(([x, y], i) => {
            const px = plot.x + x * sx;
            const py = plot.y + y * sy;
            if (i) {
              ctx.lineTo(px, py);
            } else {
              ctx.moveTo(px, py);
            }
          });
        }
      }
      ctx.stroke();
    }
  }

  private drawRoi(ctx: CanvasRenderingContext2D): void {
    const roiDepth = BOTTOM;
    const corners: Array<[number, number]> =
      this.kind === "top"
        ? [
            [NINO34.west, NINO34.north],
            [NINO34.east, NINO34.south],
          ]
        : this.kind === "eq"
          ? [
              [NINO34.west, 0],
              [NINO34.east, roiDepth],
            ]
          : [
              [NINO34.south, 0],
              [NINO34.north, roiDepth],
            ];
    const [a, b] = corners.map(([u, v]) => this.toPixel(u, v));
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
    ctx.lineWidth = 1;
    ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    ctx.setLineDash([]);
  }

  private drawCursors(
    ctx: CanvasRenderingContext2D,
    plot: { x: number; y: number; w: number; h: number },
  ): void {
    const { cursor } = this;
    const [u, v] =
      this.kind === "top"
        ? [cursor.lon, cursor.lat]
        : this.kind === "eq"
          ? [cursor.lon, cursor.depth]
          : [cursor.lat, cursor.depth];
    const [x, y] = this.toPixel(u, v);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, plot.y + plot.h);
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();
  }

  private drawAxes(
    ctx: CanvasRenderingContext2D,
    plot: { x: number; y: number; w: number; h: number },
  ): void {
    const [h, v] = this.axes();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
    ctx.fillStyle = "rgba(235, 237, 240, 0.85)";
    ctx.lineWidth = 1;
    ctx.font = FONT;
    ctx.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.w - 1, plot.h - 1);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    // Every tick, or every second one when labels would touch.
    const spacing =
      h.ticks.length > 1
        ? Math.abs(
            this.toPixel(h.ticks[1], 0)[0] - this.toPixel(h.ticks[0], 0)[0],
          )
        : Infinity;
    const label = ctx.measureText(h.label(h.ticks[0])).width + 10;
    const every = spacing < label ? Math.ceil(label / spacing) : 1;
    for (const [i, tick] of h.ticks.entries()) {
      const [x] = this.toPixel(tick, v.from);
      if (x < plot.x - 1 || x > plot.x + plot.w + 1 || i % every) {
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(x, plot.y + plot.h);
      ctx.lineTo(x, plot.y + plot.h + 4);
      ctx.stroke();
      ctx.fillText(h.label(tick), x, plot.y + plot.h + 6);
    }
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const tick of v.ticks) {
      const [, y] = this.toPixel(h.from, tick);
      if (y < plot.y - 1 || y > plot.y + plot.h + 1) {
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(plot.x - 4, y);
      ctx.lineTo(plot.x, y);
      ctx.stroke();
      ctx.fillText(v.label(tick), plot.x - 6, y);
    }
  }
}
