/** A step button, or a gap standing for hidden steps. */
export type StoryPagerItem = number | "gap";

/**
 * Step buttons to show: all of them when they fit in `slots`, else the first,
 * the last and the steps around `current`, with a gap for each hidden run.
 * A gap takes one slot and always hides at least two steps.
 */
export function storyPagerItems(
  count: number,
  current: number,
  slots = 7,
): StoryPagerItem[] {
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i);
  // First, last, two gaps and the current step, plus siblings on each side.
  const siblings = Math.max(0, Math.floor((slots - 5) / 2));
  const max = 2 * siblings + 5;
  if (count <= max) {
    return range(0, count - 1);
  }
  const at = Math.max(0, Math.min(count - 1, current));
  const edge = max - 2;
  // Near an end, a gap would hide a single step: show the edge run instead.
  if (at <= siblings + 2) {
    return [...range(0, edge - 1), "gap", count - 1];
  }
  if (at >= count - 3 - siblings) {
    return [0, "gap", ...range(count - edge, count - 1)];
  }
  return [0, "gap", ...range(at - siblings, at + siblings), "gap", count - 1];
}

/** Accessible names of the pager controls, in the story locale. */
export interface StoryPagerLabels {
  navigation: string;
  previous: string;
  next: string;
  play: string;
  pause: string;
  /** Name of step `index` (0-based), e.g. "3 — Arctic". */
  step(index: number): string;
}

export interface StoryPagerElement extends HTMLElement {
  /** Rebuild for `count` steps with the given labels. */
  configure(count: number, labels: StoryPagerLabels): void;
  /** Active step, 0-based. */
  index: number;
  playing: boolean;
  /** Progress of the active step while playing, 0–1. */
  progress: number;
  disabled: boolean;
}

/** Detail of the `story-pager-navigate` event: the requested step. */
export interface StoryPagerNavigateDetail {
  index: number;
}

/**
 * Define `<story-pager>`: ‹ 1 2 … n › ⏯ in light DOM, styled by the app.
 * Emits `story-pager-navigate` ({@link StoryPagerNavigateDetail}) and
 * `story-pager-toggle`; the app owns the state and sets it back. The active
 * step has `aria-current="step"` and its `--progress` drives a fill.
 */
export function defineStoryPager(
  registry: CustomElementRegistry = customElements,
  name = "story-pager",
): void {
  if (registry.get(name)) {
    return;
  }

  class StoryPager extends HTMLElement implements StoryPagerElement {
    private count = 0;
    private labels: StoryPagerLabels | null = null;
    private current = 0;
    private isPlaying = false;
    private fill = 0;
    private isDisabled = false;
    private readonly nav: HTMLElement;
    private readonly steps: HTMLElement;
    private readonly previous: HTMLButtonElement;
    private readonly next: HTMLButtonElement;
    private readonly toggle: HTMLButtonElement;

    constructor() {
      super();
      const doc = this.ownerDocument;
      const button = (className: string, onClick: () => void) => {
        const el = doc.createElement("button");
        el.type = "button";
        el.className = className;
        el.addEventListener("click", onClick);
        return el;
      };
      this.nav = doc.createElement("nav");
      this.nav.className = "story-pager__nav";
      this.previous = button("story-pager__previous", () =>
        this.request(this.current - 1),
      );
      this.next = button("story-pager__next", () =>
        this.request(this.current + 1),
      );
      this.toggle = button("story-pager__toggle", () =>
        this.dispatchEvent(new Event("story-pager-toggle", { bubbles: true })),
      );
      this.steps = doc.createElement("ol");
      this.steps.className = "story-pager__steps";
      this.steps.addEventListener("click", (event) => {
        const target = (event.target as Element).closest<HTMLElement>(
          "[data-step]",
        );
        if (target) {
          this.request(Number(target.dataset.step));
        }
      });
      this.nav.append(this.previous, this.steps, this.next, this.toggle);
    }

    connectedCallback(): void {
      if (!this.nav.isConnected) {
        this.append(this.nav);
      }
    }

    configure(count: number, labels: StoryPagerLabels): void {
      this.count = count;
      this.labels = labels;
      this.nav.setAttribute("aria-label", labels.navigation);
      this.previous.setAttribute("aria-label", labels.previous);
      this.next.setAttribute("aria-label", labels.next);
      this.render();
    }

    get index(): number {
      return this.current;
    }

    set index(value: number) {
      this.current = value;
      this.fill = 0;
      this.render();
    }

    get playing(): boolean {
      return this.isPlaying;
    }

    set playing(value: boolean) {
      this.isPlaying = value;
      this.syncToggle();
    }

    get progress(): number {
      return this.fill;
    }

    set progress(value: number) {
      this.fill = Math.max(0, Math.min(1, value));
      this.steps
        .querySelector<HTMLElement>('[aria-current="step"]')
        ?.style.setProperty("--progress", String(this.fill));
    }

    get disabled(): boolean {
      return this.isDisabled;
    }

    set disabled(value: boolean) {
      this.isDisabled = value;
      this.render();
    }

    private request(index: number): void {
      if (this.isDisabled || index < 0 || index >= this.count) {
        return;
      }
      this.dispatchEvent(
        new CustomEvent<StoryPagerNavigateDetail>("story-pager-navigate", {
          bubbles: true,
          detail: { index },
        }),
      );
    }

    private syncToggle(): void {
      const labels = this.labels;
      this.toggle.classList.toggle("is-playing", this.isPlaying);
      this.toggle.setAttribute("aria-pressed", String(this.isPlaying));
      if (labels) {
        this.toggle.setAttribute(
          "aria-label",
          this.isPlaying ? labels.pause : labels.play,
        );
      }
    }

    private render(): void {
      const labels = this.labels;
      if (!labels) {
        return;
      }
      const doc = this.ownerDocument;
      const focused = doc.activeElement;
      const focusedStep =
        focused instanceof HTMLElement && this.steps.contains(focused)
          ? focused.dataset.step
          : undefined;
      this.steps.replaceChildren(
        ...storyPagerItems(this.count, this.current).map((item) => {
          const li = doc.createElement("li");
          if (item === "gap") {
            li.className = "story-pager__gap";
            li.textContent = "…";
            li.setAttribute("aria-hidden", "true");
            return li;
          }
          const step = doc.createElement("button");
          step.type = "button";
          step.className = "story-pager__step";
          step.dataset.step = String(item);
          step.textContent = String(item + 1);
          step.setAttribute("aria-label", labels.step(item));
          step.disabled = this.isDisabled;
          if (item === this.current) {
            step.setAttribute("aria-current", "step");
            step.style.setProperty("--progress", String(this.fill));
          }
          li.append(step);
          return li;
        }),
      );
      if (focusedStep !== undefined) {
        this.steps
          .querySelector<HTMLElement>(`[data-step="${focusedStep}"]`)
          ?.focus();
      }
      this.previous.disabled = this.isDisabled || this.current <= 0;
      this.next.disabled = this.isDisabled || this.current >= this.count - 1;
      this.toggle.disabled = this.isDisabled;
      this.syncToggle();
    }
  }

  registry.define(name, StoryPager);
}
