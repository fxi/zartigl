/** One archive month (or chunk), epoch ms. */
export interface TimelineSpan {
  start: number;
  end: number;
}

export interface TimelineTick {
  /** Css px from the left of the track. */
  x: number;
  text: string;
  /** A year boundary. */
  major: boolean;
}

/** Spacing under which labels collide, css px. */
const LABEL_PX = 52;

/**
 * Labels of a timeline `width` px wide: every month with its short name
 * (January carries the year) when they fit, else the years, thinned so no
 * two labels collide.
 */
export function timelineTicks(
  spans: readonly TimelineSpan[],
  width: number,
  locale = "en",
): TimelineTick[] {
  if (!spans.length || width <= 0) {
    return [];
  }
  const start = spans[0].start;
  const end = spans[spans.length - 1].end;
  const total = Math.max(1, end - start);
  const x = (ms: number) => ((ms - start) / total) * width;
  const month = new Intl.DateTimeFormat(locale, {
    month: "short",
    timeZone: "UTC",
  });
  const isYearStart = (ms: number, i: number) =>
    i === 0 ||
    new Date(ms).getUTCFullYear() !==
      new Date(spans[i - 1].start).getUTCFullYear();
  if (spans.length * LABEL_PX <= width) {
    return spans.map((span, i) => {
      const major = isYearStart(span.start, i);
      return {
        x: x(span.start),
        text: major
          ? String(new Date(span.start).getUTCFullYear())
          : month.format(span.start),
        major,
      };
    });
  }
  const years = spans
    .map((span, i) => ({ span, i }))
    .filter(({ span, i }) => isYearStart(span.start, i));
  const ticks: TimelineTick[] = [];
  let last = -Infinity;
  for (const { span } of years) {
    const at = x(span.start);
    if (at - last >= LABEL_PX) {
      ticks.push({
        x: at,
        text: String(new Date(span.start).getUTCFullYear()),
        major: true,
      });
      last = at;
    }
  }
  return ticks;
}

/** Position of `time` on the timeline, 0–1. */
export function timelinePosition(
  spans: readonly TimelineSpan[],
  time: number,
): number {
  if (!spans.length) {
    return 0;
  }
  const start = spans[0].start;
  const end = spans[spans.length - 1].end;
  return Math.min(1, Math.max(0, (time - start) / Math.max(1, end - start)));
}

/** Detail of `timeline-scrub`: the requested time; `final` on release. */
export interface TimelineScrubDetail {
  time: number;
  final: boolean;
}

export interface TimelineElement extends HTMLElement {
  /** Months of the open layer and the locale of the labels. */
  setSpans(spans: readonly TimelineSpan[], locale: string, label: string): void;
  /** Playhead time, the displayed span and its readable date. */
  setTime(time: number, spanIndex: number, text: string): void;
}

/**
 * Define `<pv-timeline>`: a thin chronology of the archive months with a
 * playhead. Dragging or arrow keys emit `timeline-scrub`
 * ({@link TimelineScrubDetail}) and `timeline-hold` (detail: held). Light
 * DOM, styled by the app.
 */
export function defineTimeline(
  registry: CustomElementRegistry = customElements,
  name = "pv-timeline",
): void {
  if (registry.get(name)) {
    return;
  }

  class Timeline extends HTMLElement implements TimelineElement {
    private spans: readonly TimelineSpan[] = [];
    private locale = "en";
    private time = 0;
    private spanIndex = 0;
    private dragging = false;
    private readonly track: HTMLElement;
    private readonly months: HTMLElement;
    private readonly current: HTMLElement;
    private readonly ticks: HTMLElement;
    private readonly head: HTMLElement;
    private readonly date: HTMLElement;
    private readonly resizer = new ResizeObserver(() => this.renderTicks());

    constructor() {
      super();
      const doc = this.ownerDocument;
      const el = (className: string, tag = "div") => {
        const node = doc.createElement(tag);
        node.className = className;
        return node;
      };
      this.track = el("pv-timeline__track");
      this.track.tabIndex = 0;
      this.track.setAttribute("role", "slider");
      this.months = el("pv-timeline__months");
      this.current = el("pv-timeline__current");
      this.ticks = el("pv-timeline__ticks", "ol");
      this.head = el("pv-timeline__head");
      this.date = el("pv-timeline__date");
      this.head.append(this.date);
      this.track.append(this.months, this.current, this.head);
      this.bind();
    }

    connectedCallback(): void {
      if (!this.track.isConnected) {
        this.append(this.track, this.ticks);
      }
      this.resizer.observe(this);
    }

    disconnectedCallback(): void {
      this.resizer.disconnect();
    }

    setSpans(
      spans: readonly TimelineSpan[],
      locale: string,
      label: string,
    ): void {
      this.spans = spans;
      this.locale = locale;
      this.track.setAttribute("aria-label", label);
      if (spans.length) {
        this.track.setAttribute("aria-valuemin", String(spans[0].start));
        this.track.setAttribute(
          "aria-valuemax",
          String(spans[spans.length - 1].end),
        );
      }
      this.renderTicks();
    }

    setTime(time: number, spanIndex: number, text: string): void {
      if (this.dragging) {
        return;
      }
      this.time = time;
      this.spanIndex = spanIndex;
      this.place(time, text);
    }

    private place(time: number, text: string): void {
      const spans = this.spans;
      this.track.style.setProperty(
        "--head",
        String(timelinePosition(spans, time)),
      );
      const span = spans[this.spanIndex];
      if (span) {
        this.track.style.setProperty(
          "--span-start",
          String(timelinePosition(spans, span.start)),
        );
        this.track.style.setProperty(
          "--span-end",
          String(timelinePosition(spans, span.end)),
        );
      }
      if (this.date.textContent !== text) {
        this.date.textContent = text;
        this.track.setAttribute("aria-valuetext", text);
      }
      this.track.setAttribute("aria-valuenow", String(Math.round(time)));
    }

    private renderTicks(): void {
      const width = this.track.clientWidth;
      const spans = this.spans;
      const doc = this.ownerDocument;
      this.ticks.replaceChildren(
        ...timelineTicks(spans, width, this.locale).map((tick) => {
          const li = doc.createElement("li");
          li.textContent = tick.text;
          li.className = tick.major ? "is-major" : "";
          li.style.left = `${tick.x}px`;
          return li;
        }),
      );
      // Month separators, as one repeating gradient when they are regular.
      this.months.style.setProperty("--months", String(spans.length));
    }

    private timeAt(clientX: number): number {
      const spans = this.spans;
      const rect = this.track.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      const start = spans[0]?.start ?? 0;
      const end = spans[spans.length - 1]?.end ?? 0;
      return start + f * (end - start);
    }

    private emit(time: number, final: boolean): void {
      this.dispatchEvent(
        new CustomEvent<TimelineScrubDetail>("timeline-scrub", {
          bubbles: true,
          detail: { time, final },
        }),
      );
    }

    private hold(held: boolean): void {
      this.dispatchEvent(
        new CustomEvent<boolean>("timeline-hold", {
          bubbles: true,
          detail: held,
        }),
      );
    }

    private bind(): void {
      const track = this.track;
      track.addEventListener("pointerdown", (event) => {
        if (!this.spans.length) {
          return;
        }
        track.setPointerCapture(event.pointerId);
        this.dragging = true;
        this.classList.add("is-dragging");
        this.hold(true);
        this.drag(event.clientX);
      });
      track.addEventListener("pointermove", (event) => {
        if (this.dragging) {
          this.drag(event.clientX);
        }
      });
      const end = (event: PointerEvent) => {
        if (!this.dragging) {
          return;
        }
        this.dragging = false;
        this.classList.remove("is-dragging");
        this.emit(this.timeAt(event.clientX), true);
        this.hold(false);
      };
      track.addEventListener("pointerup", end);
      track.addEventListener("pointercancel", end);
      track.addEventListener("keydown", (event) => {
        const step =
          event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (!step || !this.spans.length) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const index = Math.min(
          this.spans.length - 1,
          Math.max(0, this.spanIndex + step),
        );
        this.emit(this.spans[index].start, true);
      });
    }

    private drag(clientX: number): void {
      const time = this.timeAt(clientX);
      this.time = time;
      this.spanIndex = Math.max(
        0,
        this.spans.findIndex((s) => time >= s.start && time <= s.end),
      );
      this.place(time, this.date.textContent ?? "");
      this.emit(time, false);
    }
  }

  registry.define(name, Timeline);
}
