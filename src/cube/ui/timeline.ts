/**
 * Monthly timeline, 1980 to the last stored month: years, the Niño 3.4
 * anomaly as bars (warm red, cold blue) over shaded El Niño / La Niña
 * episodes, a strip of the five-year data blocks (in memory, on disk,
 * loading, not loaded) and the playhead. Drag to scrub.
 */

import type { Episode } from "../data/nino";

const FONT = '10px "IBM Plex Mono", ui-monospace, monospace';
const RANGE = 2.5;
const WARM = "rgba(255, 92, 72, 0.9)";
const COLD = "rgba(72, 150, 255, 0.9)";

/** In memory, being read, on disk only (cache), or to download. */
export type BlockStatus = "loaded" | "loading" | "cached" | "missing";

export class Timeline {
  readonly canvas: HTMLCanvasElement;
  private month = 0;
  private status: BlockStatus[] = [];

  constructor(
    private times: number[],
    private index: Float64Array,
    private episodes: Episode[],
    private blockSize: number,
    private onScrub: (month: number) => void,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "timeline-canvas";
    let dragging = false;
    const scrub = (event: PointerEvent) => {
      const month = this.monthAt(event.offsetX);
      if (month !== null) {
        onScrub(month);
      }
    };
    this.canvas.addEventListener("pointerdown", (event) => {
      dragging = true;
      this.canvas.setPointerCapture(event.pointerId);
      scrub(event);
    });
    this.canvas.addEventListener(
      "pointermove",
      (event) => dragging && scrub(event),
    );
    this.canvas.addEventListener("pointerup", () => (dragging = false));
  }

  private area() {
    const ratio = window.devicePixelRatio || 1;
    const width = this.canvas.width / ratio;
    const height = this.canvas.height / ratio;
    return { x: 12, w: width - 24, height };
  }

  private x(month: number): number {
    const { x, w } = this.area();
    return x + (month / Math.max(1, this.times.length - 1)) * w;
  }

  private monthAt(px: number): number | null {
    const { x, w } = this.area();
    const f = (px - x) / w;
    return Math.round(Math.min(1, Math.max(0, f)) * (this.times.length - 1));
  }

  setMonth(month: number): void {
    this.month = month;
    this.draw();
  }

  setStatus(status: BlockStatus[]): void {
    this.status = status;
    this.draw();
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
    const { x, w, height } = this.area();
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.font = FONT;
    const top = 16;
    const strip = height - 8;
    const mid = top + (strip - 10 - top) / 2;
    const half = (strip - 10 - top) / 2;
    const step = w / Math.max(1, this.times.length - 1);

    // Episodes.
    for (const episode of this.episodes) {
      ctx.fillStyle =
        episode.phase === "el-nino"
          ? "rgba(255, 92, 72, 0.13)"
          : "rgba(72, 150, 255, 0.13)";
      ctx.fillRect(
        this.x(episode.start) - step / 2,
        top,
        this.x(episode.end) - this.x(episode.start) + step,
        strip - 10 - top,
      );
    }

    // Years.
    ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
    ctx.fillStyle = "rgba(235, 237, 240, 0.85)";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    this.times.forEach((ms, i) => {
      const date = new Date(ms);
      if (date.getUTCMonth() !== 0) {
        return;
      }
      const year = date.getUTCFullYear();
      const px = this.x(i);
      const major = year % 5 === 0;
      ctx.beginPath();
      ctx.moveTo(px, top - (major ? 4 : 2));
      ctx.lineTo(px, top);
      ctx.stroke();
      if (major && (w > 500 || year % 10 === 0)) {
        ctx.fillText(String(year), px, 2);
      }
    });

    // Anomaly bars and zero line.
    ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
    ctx.beginPath();
    ctx.moveTo(x, mid);
    ctx.lineTo(x + w, mid);
    ctx.stroke();
    const bar = Math.max(1, step * 0.8);
    this.index.forEach((value, i) => {
      if (Number.isNaN(value)) {
        return;
      }
      const v = Math.max(-RANGE, Math.min(RANGE, value));
      ctx.fillStyle = v >= 0 ? WARM : COLD;
      const h = (v / RANGE) * half;
      ctx.fillRect(
        this.x(i) - bar / 2,
        v >= 0 ? mid - h : mid,
        bar,
        Math.abs(h),
      );
    });

    // Data blocks.
    this.status.forEach((status, b) => {
      const start = this.x(b * this.blockSize) - step / 2;
      const end =
        this.x(Math.min(this.times.length - 1, (b + 1) * this.blockSize - 1)) +
        step / 2;
      ctx.fillStyle =
        status === "loaded"
          ? "rgba(255, 255, 255, 0.7)"
          : status === "loading"
            ? "rgba(255, 255, 255, 0.3)"
            : status === "cached"
              ? "rgba(255, 255, 255, 0.45)"
              : "rgba(255, 255, 255, 0.08)";
      ctx.fillRect(start + 1, strip - 4, end - start - 2, 3);
    });

    // Playhead.
    const px = this.x(this.month);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, top - 2);
    ctx.lineTo(px, strip);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(px - 3, top - 6, 6, 6);
  }
}
