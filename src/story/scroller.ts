/** The part of IntersectionObserver the scroller uses; injectable for tests. */
export type StoryScrollObserverFactory = (
  callback: (entries: readonly StoryScrollEntry[]) => void,
  init: IntersectionObserverInit,
) => { observe(target: Element): void; disconnect(): void };

/** The part of IntersectionObserverEntry the scroller reads. */
export interface StoryScrollEntry {
  target: Element;
  isIntersecting: boolean;
}

export interface StoryScrollerOptions {
  /**
   * Activation line, as a share of the viewport height from the top: the
   * section that crosses it is the active one. Defaults to 0.5.
   */
  line?: number;
  /** Scroll container; the viewport when omitted. */
  root?: Element | null;
  createObserver?: StoryScrollObserverFactory;
}

/** Thickness of the activation band, in percent of the root height. */
const BAND = 1;

/** `rootMargin` that shrinks the root to a band at `line`. */
export function activationMargin(line: number): string {
  const top = Math.min(100 - BAND, Math.max(0, line * 100));
  const bottom = 100 - BAND - top;
  return `-${round(top)}% 0px -${round(bottom)}% 0px`;
}

const round = (value: number) => Math.round(value * 100) / 100;

const defaultObserver: StoryScrollObserverFactory = (callback, init) =>
  new IntersectionObserver(callback, init);

/**
 * Scroll-driven scene activation: watches a list of sections and reports the
 * one crossing the activation line. Between sections, the last one stays
 * active, so a gap or a section taller than the viewport never blanks the
 * view. No scroll listener: one IntersectionObserver.
 */
export class StoryScroller {
  private readonly observer: ReturnType<StoryScrollObserverFactory>;
  private readonly crossing = new Set<number>();
  private activeIndex = -1;

  /**
   * @param sections Scene sections in document order.
   * @param onActivate Called once each time another section becomes active.
   */
  constructor(
    private readonly sections: readonly Element[],
    private readonly onActivate: (index: number, section: Element) => void,
    options: StoryScrollerOptions = {},
  ) {
    const create = options.createObserver ?? defaultObserver;
    this.observer = create((entries) => this.update(entries), {
      root: options.root ?? null,
      rootMargin: activationMargin(options.line ?? 0.5),
      threshold: 0,
    });
    for (const section of sections) {
      this.observer.observe(section);
    }
  }

  /** Index of the active section, -1 before the first one is reached. */
  get active(): number {
    return this.activeIndex;
  }

  destroy(): void {
    this.observer.disconnect();
    this.crossing.clear();
  }

  private update(entries: readonly StoryScrollEntry[]): void {
    for (const entry of entries) {
      const index = this.sections.indexOf(entry.target);
      if (index < 0) {
        continue;
      }
      if (entry.isIntersecting) {
        this.crossing.add(index);
      } else {
        this.crossing.delete(index);
      }
    }
    if (this.crossing.size === 0) {
      return;
    }
    // Adjacent sections can share the band for a frame: the lower one wins.
    const index = Math.max(...this.crossing);
    if (index !== this.activeIndex) {
      this.activeIndex = index;
      this.onActivate(index, this.sections[index]);
    }
  }
}
