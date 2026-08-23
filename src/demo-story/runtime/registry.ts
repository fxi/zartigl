import type { StoryViewAdapter, StoryViewAdapterFactory, StoryWidgetRenderer } from "./types";

export class StoryRegistry {
  private readonly viewFactories = new Map<string, StoryViewAdapterFactory>();
  private readonly viewAdapters = new Map<string, StoryViewAdapter>();
  private readonly widgets = new Map<string, StoryWidgetRenderer>();

  registerViewType(type: string, factory: StoryViewAdapterFactory): this {
    if (this.viewFactories.has(type)) throw new Error(`View type already registered: ${type}`);
    this.viewFactories.set(type, factory);
    return this;
  }

  registerWidgetType(type: string, renderer: StoryWidgetRenderer): this {
    if (this.widgets.has(type)) throw new Error(`Widget type already registered: ${type}`);
    this.widgets.set(type, renderer);
    return this;
  }

  getViewAdapter(type: string): StoryViewAdapter {
    const existing = this.viewAdapters.get(type);
    if (existing) return existing;
    const factory = this.viewFactories.get(type);
    if (!factory) throw new Error(`Unregistered view type: ${type}`);
    const adapter = factory();
    this.viewAdapters.set(type, adapter);
    return adapter;
  }

  getWidget(type: string): StoryWidgetRenderer {
    const renderer = this.widgets.get(type);
    if (!renderer) throw new Error(`Unregistered widget type: ${type}`);
    return renderer;
  }

  destroy(): void {
    for (const adapter of this.viewAdapters.values()) adapter.destroy();
    this.viewAdapters.clear();
  }
}
