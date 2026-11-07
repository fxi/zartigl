/**
 * The DATA panel: what the browser keeps of the cube between sessions, one
 * row per five-year block (the store's time chunk). Each row shows the chunks
 * on disk for the variables of the current mode, their size and date, and
 * downloads or removes the block. Playback fills the cache on its own: every
 * chunk the cube reads is kept (see lib/chunkStore.ts).
 */

import type { ChunkEntry, ChunkStore } from "../../lib/chunkStore";

/** A chunk of a block, with the revision a stored copy must carry. */
export interface BlockChunk {
  url: string;
  revision: string;
}

export interface DataBlock {
  index: number;
  /** Years of the block, e.g. 1980–1984. */
  label: string;
  /** The chunks of the variables the current mode shows. */
  chunks: BlockChunk[];
  /** The chunks of every variable, removed together. */
  all: string[];
}

export interface DataManagerOptions {
  button: HTMLButtonElement;
  store: ChunkStore;
  /** Root URL of the store: every chunk of the cube starts with it. */
  prefix: string;
  blocks: () => DataBlock[];
  facts: () => Array<[string, string]>;
  /** Reads block `index` through the chunk store, reporting chunks read. */
  download: (
    index: number,
    onProgress: (done: number, total: number) => void,
  ) => Promise<void>;
  /** Called with the blocks complete on disk after each refresh. */
  onChange: (complete: Set<number>) => void;
}

interface BlockStats {
  cached: number;
  total: number;
  size: number;
  storedAt: number;
}

function megabytes(bytes: number): string {
  return bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(2)} GB`
    : bytes >= 1e7 || bytes === 0
      ? `${Math.round(bytes / 1e6)} MB`
      : `${(bytes / 1e6).toFixed(1)} MB`;
}

function day(ms: number): string {
  return ms ? new Date(ms).toISOString().slice(0, 10) : "—";
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  className = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) {
    node.className = className;
  }
  return node;
}

export class DataManager {
  readonly panel: HTMLElement;
  private stats = new Map<number, BlockStats>();
  private usage: { usage: number; quota: number } | undefined;
  private running: { index: number; done: number; total: number } | null = null;
  private stopping = false;
  private refreshing: Promise<void> | null = null;

  constructor(private options: DataManagerOptions) {
    this.panel = element("section", "", "data-manager");
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-label", "Data cache");
    this.panel.hidden = true;
    document.body.append(this.panel);
    options.button.addEventListener("click", () => this.toggle());
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.close();
      }
    });
    document.addEventListener("pointerdown", (event) => {
      const target = event.target as Node;
      if (
        !this.panel.hidden &&
        !this.panel.contains(target) &&
        !options.button.contains(target)
      ) {
        this.close();
      }
    });
    window.addEventListener("resize", () => this.place());
  }

  /** Blocks whose chunks of the current mode are all on disk and current. */
  complete(): Set<number> {
    const result = new Set<number>();
    for (const [index, stats] of this.stats) {
      if (stats.total > 0 && stats.cached === stats.total) {
        result.add(index);
      }
    }
    return result;
  }

  toggle(): void {
    if (this.panel.hidden) {
      this.open();
    } else {
      this.close();
    }
  }

  open(): void {
    this.panel.hidden = false;
    this.options.button.setAttribute("aria-expanded", "true");
    this.render();
    this.place();
    void this.refresh();
  }

  close(): void {
    this.panel.hidden = true;
    this.options.button.setAttribute("aria-expanded", "false");
  }

  /** Reads what is on disk, then redraws and reports the complete blocks. */
  refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      const entries = await this.options.store.entries(this.options.prefix);
      const byUrl = new Map<string, ChunkEntry>(
        entries.map((entry) => [entry.url, entry]),
      );
      this.stats.clear();
      for (const block of this.options.blocks()) {
        const stats: BlockStats = {
          cached: 0,
          total: block.chunks.length,
          size: 0,
          storedAt: 0,
        };
        for (const chunk of block.chunks) {
          const entry = byUrl.get(chunk.url);
          if (entry && entry.revision === chunk.revision) {
            stats.cached++;
            stats.size += entry.size;
            stats.storedAt = Math.max(stats.storedAt, entry.storedAt);
          }
        }
        this.stats.set(block.index, stats);
      }
      this.usage = await this.options.store.estimate();
      this.render();
      this.options.onChange(this.complete());
    })().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async download(indices: number[]): Promise<void> {
    if (this.running) {
      return;
    }
    this.stopping = false;
    for (const index of indices) {
      if (this.stopping) {
        break;
      }
      this.running = { index, done: 0, total: 0 };
      this.render();
      try {
        await this.options.download(index, (done, total) => {
          this.running = { index, done, total };
          this.render();
        });
      } finally {
        this.running = null;
      }
      await this.refresh();
    }
    this.running = null;
    this.render();
  }

  private async remove(urls: string[]): Promise<void> {
    await this.options.store.delete(urls);
    await this.refresh();
  }

  /** Above the DATA button, inside the viewport; a sheet along the bottom on phones. */
  private place(): void {
    if (this.panel.hidden) {
      return;
    }
    const style = this.panel.style;
    // Phones: the time bar is mid-page, so the panel is a sheet along the bottom of the screen.
    if (window.innerWidth <= 760) {
      style.left = "8px";
      style.bottom = "8px";
      style.maxHeight = `${Math.round(window.innerHeight * 0.8)}px`;
      return;
    }
    const button = this.options.button.getBoundingClientRect();
    const width = this.panel.offsetWidth;
    const left = Math.max(
      12,
      Math.min(button.left, window.innerWidth - width - 12),
    );
    style.left = `${left}px`;
    style.bottom = `${Math.max(12, window.innerHeight - button.top + 8)}px`;
    // Never above the top of the screen: the rows scroll instead.
    style.maxHeight = `${Math.max(160, Math.min(560, button.top - 20))}px`;
  }

  private render(): void {
    if (this.panel.hidden) {
      return;
    }
    const blocks = this.options.blocks();
    const busy = this.running !== null;

    const header = element("header");
    header.append(element("h2", "DATA — CACHE"));
    const actions = element("div", "", "actions");
    const all = element("button", busy ? "Stop" : "Download all");
    all.type = "button";
    all.addEventListener("click", () => {
      if (this.running) {
        this.stopping = true;
        all.disabled = true;
        return;
      }
      const missing = blocks
        .filter((block) => !this.complete().has(block.index))
        .map((block) => block.index);
      void this.download(missing);
    });
    const clear = element("button", "Remove all");
    clear.type = "button";
    clear.disabled = busy;
    clear.addEventListener("click", () =>
      this.remove(blocks.flatMap((block) => block.all)),
    );
    const close = element("button", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => this.close());
    actions.append(all, clear, close);
    header.append(actions);

    const facts = element("dl", "", "facts");
    for (const [term, value] of this.options.facts()) {
      facts.append(element("dt", term), element("dd", value));
    }

    let size = 0;
    for (const stats of this.stats.values()) {
      size += stats.size;
    }
    const usage = element(
      "p",
      `On disk: ${megabytes(size)} for this mode` +
        (this.usage
          ? ` · browser storage ${megabytes(this.usage.usage)} of ${megabytes(this.usage.quota)}`
          : "") +
        " · playback keeps every block it reads",
      "usage",
    );

    const table = element("table");
    const head = element("tr");
    for (const title of ["Period", "Size", "Date", "Chunks", ""]) {
      head.append(element("th", title));
    }
    table.append(head);
    for (const block of blocks) {
      const stats = this.stats.get(block.index);
      const running = this.running?.index === block.index ? this.running : null;
      const row = element("tr");
      if (stats && stats.total > 0 && stats.cached === stats.total) {
        row.className = "is-complete";
      }
      const progress = running
        ? `${running.done}/${running.total || block.chunks.length} …`
        : stats
          ? `${stats.cached}/${stats.total}`
          : "…";
      row.append(
        element("td", block.label),
        element("td", stats ? megabytes(stats.size) : "—", "num"),
        element("td", day(stats?.storedAt ?? 0)),
        element("td", progress, "num"),
      );
      const cell = element("td");
      const buttons = element("div", "", "row-actions");
      const get = element("button", "↓");
      get.type = "button";
      get.title = `Download ${block.label}`;
      get.disabled = busy || (stats?.cached === stats?.total && !!stats?.total);
      get.addEventListener("click", () => this.download([block.index]));
      const drop = element("button", "✕");
      drop.type = "button";
      drop.title = `Remove ${block.label}`;
      drop.disabled = busy || !stats?.cached;
      drop.addEventListener("click", () => this.remove(block.all));
      buttons.append(get, drop);
      cell.append(buttons);
      row.append(cell);
      table.append(row);
    }

    this.panel.replaceChildren(header, facts, usage, table);
  }
}
