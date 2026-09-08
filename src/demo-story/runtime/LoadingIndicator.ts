export interface LoadingIndicatorOptions {
  revealDelayMs?: number;
  minimumVisibleMs?: number;
}

export class LoadingIndicator {
  private readonly revealDelayMs: number;
  private readonly minimumVisibleMs: number;
  private revealTimer: ReturnType<typeof setTimeout> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private shownAt = 0;
  private visible = false;

  constructor(
    private readonly update: (visible: boolean) => void,
    options: LoadingIndicatorOptions = {},
  ) {
    this.revealDelayMs = options.revealDelayMs ?? 120;
    this.minimumVisibleMs = options.minimumVisibleMs ?? 450;
  }

  show(): void {
    this.clearHideTimer();
    if (this.visible || this.revealTimer !== null) {
      return;
    }
    this.revealTimer = setTimeout(() => {
      this.revealTimer = null;
      this.visible = true;
      this.shownAt = Date.now();
      this.update(true);
    }, this.revealDelayMs);
  }

  hide(immediate = false): void {
    this.clearRevealTimer();
    this.clearHideTimer();
    if (!this.visible) {
      return;
    }
    const delay = immediate
      ? 0
      : Math.max(0, this.minimumVisibleMs - (Date.now() - this.shownAt));
    if (delay === 0) {
      this.setVisible(false);
      return;
    }
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this.setVisible(false);
    }, delay);
  }

  private setVisible(visible: boolean): void {
    if (this.visible === visible) {
      return;
    }
    this.visible = visible;
    this.update(visible);
  }

  private clearRevealTimer(): void {
    if (this.revealTimer === null) {
      return;
    }
    clearTimeout(this.revealTimer);
    this.revealTimer = null;
  }

  private clearHideTimer(): void {
    if (this.hideTimer === null) {
      return;
    }
    clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }
}
