export type StoryWidgetCleanup = () => void;

export interface StoryWidgetRun {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  runIfCurrent(effect: () => void): boolean;
  settle(cleanup: StoryWidgetCleanup | void): void;
}

export class StoryWidgetLifecycle {
  private generation = 0;
  private controller: AbortController | null = null;
  private cleanup: StoryWidgetCleanup | null = null;

  constructor(private readonly onCleanupError: (error: unknown) => void = console.error) {}

  begin(): StoryWidgetRun {
    this.cancel();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    return {
      signal: controller.signal,
      isCurrent: () => this.generation === generation && !controller.signal.aborted,
      runIfCurrent: (effect) => {
        if (this.generation !== generation || controller.signal.aborted) return false;
        effect();
        return true;
      },
      settle: (cleanup) => {
        if (!cleanup) return;
        if (this.generation !== generation || controller.signal.aborted) {
          this.invoke(cleanup);
          return;
        }
        this.cleanup = cleanup;
      },
    };
  }

  cancel(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    const cleanup = this.cleanup;
    this.cleanup = null;
    if (cleanup) this.invoke(cleanup);
  }

  private invoke(cleanup: StoryWidgetCleanup): void {
    try {
      cleanup();
    } catch (error) {
      this.onCleanupError(error);
    }
  }
}
