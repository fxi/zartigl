import { normalizeBearing, pointerBearing } from "../projversor";

/** Keyboard bearing step, in degrees. */
const KEY_STEP = 5;
/** Pointer travel, in css px, that turns a press into a drag. */
const DRAG_PX = 3;

export interface CompassHandlers {
  /** The handle or keys set a bearing (degrees, clockwise from up). */
  onBearing(deg: number): void;
  /** A click without drag. */
  onToggle(): void;
}

/**
 * North arrow button: shows the bearing, sets it by dragging around the
 * ring (relative to the press, so the map never jumps) or with the arrow
 * keys, and reports plain clicks.
 */
export class Compass {
  private shown = Number.NaN;
  private current = 0;
  private press: {
    id: number;
    x: number;
    y: number;
    angle: number;
    bearing: number;
    dragging: boolean;
  } | null = null;

  constructor(
    private readonly button: HTMLButtonElement,
    private readonly needle: SVGElement,
    handlers: CompassHandlers,
  ) {
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }
      button.setPointerCapture(event.pointerId);
      this.press = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        angle: this.angle(event),
        bearing: this.current,
        dragging: false,
      };
    });
    button.addEventListener("pointermove", (event) => {
      const press = this.press;
      if (!press || press.id !== event.pointerId) {
        return;
      }
      if (
        !press.dragging &&
        Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_PX
      ) {
        return;
      }
      press.dragging = true;
      handlers.onBearing(
        normalizeBearing(press.bearing + this.angle(event) - press.angle),
      );
    });
    const end = (event: PointerEvent) => {
      const press = this.press;
      if (!press || press.id !== event.pointerId) {
        return;
      }
      this.press = null;
      if (event.type === "pointerup" && !press.dragging) {
        handlers.onToggle();
      }
    };
    button.addEventListener("pointerup", end);
    button.addEventListener("pointercancel", end);
    button.addEventListener("keydown", (event) => {
      const step =
        event.key === "ArrowRight"
          ? KEY_STEP
          : event.key === "ArrowLeft"
            ? -KEY_STEP
            : 0;
      if (step) {
        event.preventDefault();
        handlers.onBearing(normalizeBearing(this.current + step));
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handlers.onToggle();
      }
    });
  }

  /** Turn the needle; skips the DOM when the rounded angle is unchanged. */
  set bearing(deg: number) {
    this.current = deg;
    const rounded = Math.round(deg * 10) / 10;
    if (rounded !== this.shown) {
      this.shown = rounded;
      this.needle.setAttribute("transform", `rotate(${rounded} 24 24)`);
    }
  }

  set locked(locked: boolean) {
    this.button.setAttribute("aria-pressed", String(locked));
    this.button.setAttribute(
      "aria-label",
      locked ? "North up, locked" : "Bearing free; click to reset north",
    );
  }

  private angle(event: PointerEvent): number {
    const rect = this.button.getBoundingClientRect();
    return pointerBearing(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      event.clientX,
      event.clientY,
    );
  }
}
