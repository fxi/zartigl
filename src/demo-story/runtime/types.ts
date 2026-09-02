export type LocalizedText = Record<string, string>;

export type StoryAnchor =
  | "center"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export type StorySlot = "copy" | "stage" | "analysis" | "edge";

export interface StoryTheme {
  background: string;
  foreground: string;
  muted: string;
  accent: string;
  accentSoft: string;
  surface: string;
  glowAnchor?: StoryAnchor;
}

interface StoryBlockBase {
  id: string;
  slot: StorySlot;
  anchor?: StoryAnchor;
}

export interface StoryCopyBlock extends StoryBlockBase {
  type: "copy";
  label?: LocalizedText;
  heading: LocalizedText;
  text?: LocalizedText;
  references?: StoryReference[];
  showTime?: boolean;
  backdrop?: "none" | "dark-gradient";
  orientation?: "horizontal" | "vertical-rl";
  variant?: "hero" | "standard";
}

export interface StoryReference {
  label: LocalizedText;
  url: string;
}

export interface StoryViewBlock extends StoryBlockBase {
  type: "view";
  view: string;
  presentation?: "background" | "panel";
}

export interface StoryWidgetBlock extends StoryBlockBase {
  type: "widget";
  widget: string;
  config?: Record<string, unknown>;
  caption?: LocalizedText;
}

export interface StoryTextBlock extends StoryBlockBase {
  type: "text" | "credit" | "label";
  text: LocalizedText;
  orientation?: "horizontal" | "vertical-rl";
  variant?: "standard" | "small";
}

export type StoryBlock = StoryCopyBlock | StoryViewBlock | StoryWidgetBlock | StoryTextBlock;

export type StoryPlayback =
  | { mode: "none" }
  | { mode: "autoplay" }
  | { mode: "sequence"; times: string[]; intervalMs: number; direction?: "loop" | "ping-pong" };

export interface StoryScene {
  id: string;
  name: LocalizedText;
  chapter?: string;
  theme: string;
  layout: "full" | "split-left" | "split-right" | "overlay";
  blocks: StoryBlock[];
  playback?: StoryPlayback;
}

export interface StoryDocument {
  schemaVersion: 1;
  defaultLocale: string;
  fallbackLocales?: string[];
  title: LocalizedText;
  themes: Record<string, StoryTheme>;
  chrome?: { verticalMark?: LocalizedText };
  scenes: StoryScene[];
}

export interface StoryViewDefinition {
  id: string;
  type: string;
  config: Record<string, unknown>;
}

export interface StoryViewsDocument {
  schemaVersion: 1;
  views: StoryViewDefinition[];
}

export interface StoryViewAdapter {
  activate(view: StoryViewDefinition, scene: StoryScene): Promise<void> | void;
  play?(): Promise<void> | void;
  pause?(): void;
  setTime?(time: number): void;
  deactivate?(): void;
  destroy(): void;
}

export interface StoryWidgetContext {
  scene: StoryScene;
  block: StoryWidgetBlock;
  locale: string;
  signal: AbortSignal;
  getViewAdapter(viewId: string): StoryViewAdapter | undefined;
  setTimeCursor(cursor: (time: number) => void): void;
  beginTimeInteraction(): void;
  requestTime(time: number): void;
  endTimeInteraction(): void;
}

export type StoryWidgetRenderer = (
  host: HTMLElement,
  config: Record<string, unknown>,
  context: StoryWidgetContext,
) => Promise<(() => void) | void> | (() => void) | void;

export type StoryViewAdapterFactory = () => StoryViewAdapter;
