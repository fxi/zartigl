// ── Trail fade mapping ───────────────────────────────────────────────
// Public `fade` is an intuitive 0–1 trail length (higher = longer). It maps to
// the renderer's raw per-frame fade-opacity. Trail length in frames is
// interpolated geometrically (perceptually even across the wide range), then
// converted to the multiplier f via f^N ≈ e^-1.
const FADE_NMIN = 20; // trail length in frames at fade = 0
const FADE_NMAX = 600; // trail length in frames at fade = 1

/** Trail length in frames for a 0–1 `fade`. */
export function fadeToFrames(fade: number): number {
  const t = Math.max(0, Math.min(1, fade));
  return FADE_NMIN * Math.pow(FADE_NMAX / FADE_NMIN, t);
}

/** Per-frame trail opacity multiplier for a 0–1 `fade`. */
export function fadeToOpacity(fade: number): number {
  return Math.exp(-1 / fadeToFrames(fade));
}

// Trail history is screen-space and cannot remain geographically exact while
// the camera moves. Retain a few frames for visual continuity, but decay them
// quickly enough that displaced trails do not linger.
const MOVING_FADE_OPACITY = 0.8;
const MOVING_FADE_OUT_MS = 120;
const MOVING_FADE_IN_MS = 300;

/**
 * Camera-aware per-frame fade opacity: eases toward a short retention while
 * the camera moves, then back to the configured one. Smoothstep avoids
 * visible slope changes at both ends.
 */
export class TrailFade {
  private moving = false;
  private from: number;
  private to: number;
  private start = 0;
  private duration = 0;

  constructor(private base: number) {
    this.from = base;
    this.to = base;
  }

  /** Configured opacity, applied at once unless the camera moves. */
  setBase(base: number): void {
    this.base = base;
    if (!this.moving) {
      this.from = base;
      this.to = base;
      this.duration = 0;
    }
  }

  setMoving(moving: boolean, now: number): void {
    if (moving === this.moving) {
      return;
    }
    this.from = this.value(now);
    this.moving = moving;
    this.to = moving ? MOVING_FADE_OPACITY : this.base;
    this.start = now;
    this.duration = moving ? MOVING_FADE_OUT_MS : MOVING_FADE_IN_MS;
  }

  value(now: number): number {
    if (this.duration === 0) {
      return this.to;
    }
    const t = Math.min(1, Math.max(0, (now - this.start) / this.duration));
    if (t === 1) {
      this.duration = 0;
      this.from = this.to;
      return this.to;
    }
    return this.from + (this.to - this.from) * t * t * (3 - 2 * t);
  }
}
