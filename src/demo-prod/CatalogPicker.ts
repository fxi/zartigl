import type { BladeApi, FolderApi } from "@tweakpane/core";
import { resolveLocalizedText, searchCatalog } from "../catalog";
import type { Catalog, CatalogEntry, CatalogSource } from "../catalog";
import { addDomBlade } from "./DomBladePlugin";

export interface CatalogPickerOptions {
  catalog: Catalog;
  locale: string;
  selected: CatalogEntry;
  onSelect(entry: CatalogEntry): void;
}

export interface CatalogResultMetadata {
  overview: string;
  identifiers: string;
  details: string;
}

export interface CatalogPickerBlade {
  blade: BladeApi;
  picker: CatalogPicker;
}

let nextPickerId = 0;

function sourceVariables(source: CatalogSource): string[] {
  if (source.type !== "zarr") return [];
  if (source.variables.kind === "scalar") return [source.variables.value];
  if (source.variables.derivation) {
    return [
      source.variables.derivation.direction_variable,
      source.variables.derivation.magnitude_variable,
    ];
  }
  return [source.variables.u, source.variables.v].filter((value): value is string => !!value);
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}

function sourceLabel(type: CatalogSource["type"]): string {
  if (type === "wmts") return "WMTS";
  if (type === "geovideo") return "GeoVideo";
  return "Zarr";
}

export function buildCatalogResultMetadata(entry: CatalogEntry): CatalogResultMetadata {
  const source = entry.sources.find((candidate) => candidate.id === entry.defaults.sourceId)
    ?? entry.sources[0];
  const providers = unique(entry.sources.map((candidate) => candidate.provenance?.provider));
  const sourceTypes = unique(entry.sources.map((candidate) => sourceLabel(candidate.type)));
  const identifiers = source?.provenance?.identifiers
    ? unique(Object.values(source.provenance.identifiers)).join(" · ")
    : "";
  const variables = source ? sourceVariables(source) : [];

  return {
    overview: unique([entry.category, entry.kind, ...providers, sourceTypes.join("/")]).join(" · "),
    identifiers,
    details: unique([
      source?.temporal?.mode,
      source?.temporal?.cadence,
      variables.length ? `vars: ${variables.join(", ")}` : undefined,
    ]).join(" · "),
  };
}

export class CatalogPicker {
  readonly element: HTMLDivElement;

  private readonly input: HTMLInputElement;
  private readonly dropdown: HTMLDivElement;
  private readonly resultsEl: HTMLDivElement;
  private readonly resultCountEl: HTMLSpanElement;
  private readonly detailsEl: HTMLDivElement;
  private readonly listboxId: string;
  private results: CatalogEntry[] = [];
  private activeIndex = -1;
  private selected: CatalogEntry;
  private open = false;

  constructor(private readonly options: CatalogPickerOptions) {
    this.selected = options.selected;
    this.listboxId = `zartigl-catalog-results-${++nextPickerId}`;
    this.element = document.createElement("div");
    this.element.className = "catalog-picker";

    const searchRow = document.createElement("div");
    searchRow.className = "catalog-search-row";
    this.input = document.createElement("input");
    this.input.className = "catalog-search-input";
    this.input.type = "search";
    this.input.placeholder = "Search catalog…";
    this.input.setAttribute("role", "combobox");
    this.input.setAttribute("aria-label", "Search catalog");
    this.input.setAttribute("aria-autocomplete", "list");
    this.input.setAttribute("aria-haspopup", "listbox");
    this.input.setAttribute("aria-controls", this.listboxId);
    this.input.setAttribute("aria-expanded", "false");

    const clear = document.createElement("button");
    clear.className = "catalog-search-clear";
    clear.type = "button";
    clear.textContent = "×";
    clear.title = "Clear search";
    clear.setAttribute("aria-label", "Clear catalog search");
    searchRow.append(this.input, clear);

    this.dropdown = document.createElement("div");
    this.dropdown.className = "catalog-dropdown";
    this.dropdown.hidden = true;

    const resultHeader = document.createElement("div");
    resultHeader.className = "catalog-result-header";
    const resultLabel = document.createElement("span");
    resultLabel.textContent = "Layers";
    this.resultCountEl = document.createElement("span");
    this.resultCountEl.className = "catalog-result-count";
    resultHeader.append(resultLabel, this.resultCountEl);

    this.resultsEl = document.createElement("div");
    this.resultsEl.id = this.listboxId;
    this.resultsEl.className = "catalog-results";
    this.resultsEl.setAttribute("role", "listbox");

    const footer = document.createElement("div");
    footer.className = "catalog-result-footer";
    const footerCount = document.createElement("span");
    footerCount.className = "catalog-footer-count";
    const footerKeys = document.createElement("span");
    footerKeys.textContent = "↑/↓ navigate · Enter select";
    footer.append(footerCount, footerKeys);
    this.dropdown.append(resultHeader, this.resultsEl, footer);

    this.detailsEl = document.createElement("div");
    this.detailsEl.className = "catalog-details";
    this.element.append(searchRow, this.dropdown, this.detailsEl);

    this.input.addEventListener("focus", () => this.show());
    this.input.addEventListener("click", () => this.show());
    this.input.addEventListener("input", () => {
      this.activeIndex = 0;
      this.show();
      this.renderResults();
    });
    this.input.addEventListener("keydown", (event) => this.onKeyDown(event));
    clear.addEventListener("click", () => {
      this.input.value = "";
      this.activeIndex = this.selectedResultIndex();
      this.input.focus();
      this.show();
      this.renderResults();
    });
    this.element.addEventListener("focusout", (event) => {
      const next = event.relatedTarget;
      if (!(next instanceof Node) || !this.element.contains(next)) this.hide();
    });
    document.addEventListener("pointerdown", this.onDocumentPointerDown, true);

    this.renderResults();
    this.renderDetails();
  }

  setSelected(entry: CatalogEntry): void {
    this.selected = entry;
    this.renderResults();
    this.renderDetails();
  }

  dispose(): void {
    document.removeEventListener("pointerdown", this.onDocumentPointerDown, true);
  }

  private readonly onDocumentPointerDown = (event: PointerEvent): void => {
    if (event.target instanceof Node && !this.element.contains(event.target)) this.hide();
  };

  private show(): void {
    if (!this.open) {
      this.open = true;
      this.dropdown.hidden = false;
      this.input.setAttribute("aria-expanded", "true");
      if (!this.input.value.trim()) this.activeIndex = this.selectedResultIndex();
    }
    this.renderResults();
  }

  private hide(): void {
    this.open = false;
    this.dropdown.hidden = true;
    this.input.setAttribute("aria-expanded", "false");
    this.input.removeAttribute("aria-activedescendant");
  }

  private selectedResultIndex(): number {
    const entries = this.filteredResults();
    const index = entries.findIndex((entry) => entry.id === this.selected.id);
    return index < 0 ? 0 : index;
  }

  private filteredResults(): CatalogEntry[] {
    const query = this.input.value.trim();
    return query
      ? searchCatalog(query, { locale: this.options.locale }, this.options.catalog)
      : [...this.options.catalog.layers];
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      this.hide();
      return;
    }
    if (event.key === "Tab") {
      this.hide();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!this.open) this.show();
      if (!this.results.length) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      this.activeIndex = (this.activeIndex + delta + this.results.length) % this.results.length;
      this.renderResults();
      this.resultsEl.children[this.activeIndex]?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (event.key === "Enter" && this.open) {
      event.preventDefault();
      const entry = this.results[this.activeIndex] ?? this.results[0];
      if (entry) this.select(entry);
    }
  }

  private select(entry: CatalogEntry): void {
    this.selected = entry;
    this.input.value = "";
    this.hide();
    this.renderDetails();
    this.options.onSelect(entry);
  }

  private renderResults(): void {
    this.results = this.filteredResults();
    this.activeIndex = this.results.length
      ? Math.max(0, Math.min(this.activeIndex, this.results.length - 1))
      : -1;
    this.resultCountEl.textContent = `${this.results.length}/${this.options.catalog.layers.length}`;
    const footerCount = this.dropdown.querySelector<HTMLElement>(".catalog-footer-count");
    if (footerCount) footerCount.textContent = `${this.results.length} result${this.results.length === 1 ? "" : "s"}`;
    this.resultsEl.replaceChildren();

    if (!this.results.length) {
      const empty = document.createElement("div");
      empty.className = "catalog-empty";
      empty.textContent = "No matching catalog layers.";
      this.resultsEl.appendChild(empty);
      this.input.removeAttribute("aria-activedescendant");
      return;
    }

    this.results.forEach((entry, index) => {
      const item = document.createElement("button");
      item.type = "button";
      item.tabIndex = -1;
      item.id = `${this.listboxId}-option-${index}`;
      item.className = "catalog-result";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(entry.id === this.selected.id));
      item.classList.toggle("active", index === this.activeIndex);
      item.classList.toggle("selected", entry.id === this.selected.id);

      const title = document.createElement("span");
      title.className = "catalog-result-title";
      title.textContent = resolveLocalizedText(entry.title, this.options.locale, this.options.catalog.defaultLocale);
      item.appendChild(title);

      const metadata = buildCatalogResultMetadata(entry);
      for (const [className, value] of [
        ["catalog-result-meta", metadata.overview],
        ["catalog-result-identifiers", metadata.identifiers],
        ["catalog-result-details", metadata.details],
      ] as const) {
        if (!value) continue;
        const line = document.createElement("span");
        line.className = className;
        line.textContent = value;
        line.title = value;
        item.appendChild(line);
      }

      const description = resolveLocalizedText(
        entry.description,
        this.options.locale,
        this.options.catalog.defaultLocale,
      );
      item.title = [description, metadata.overview, metadata.identifiers, metadata.details]
        .filter(Boolean).join("\n");
      item.addEventListener("mouseenter", () => {
        this.activeIndex = index;
        this.updateActiveResult();
      });
      item.addEventListener("mousedown", (event) => event.preventDefault());
      item.addEventListener("click", () => this.select(entry));
      this.resultsEl.appendChild(item);
    });

    this.updateActiveResult();
  }

  private updateActiveResult(): void {
    for (const [index, child] of Array.from(this.resultsEl.children).entries()) {
      child.classList.toggle("active", index === this.activeIndex);
    }
    const active = this.resultsEl.children[this.activeIndex] as HTMLElement | undefined;
    if (this.open && active) this.input.setAttribute("aria-activedescendant", active.id);
    else this.input.removeAttribute("aria-activedescendant");
  }

  private renderDetails(): void {
    const layer = this.selected;
    this.detailsEl.replaceChildren();
    const heading = document.createElement("div");
    heading.className = "catalog-details-title";
    heading.textContent = resolveLocalizedText(layer.title, this.options.locale, this.options.catalog.defaultLocale);
    this.detailsEl.appendChild(heading);
    const description = resolveLocalizedText(layer.description, this.options.locale, this.options.catalog.defaultLocale);
    if (description) {
      const text = document.createElement("div");
      text.className = "catalog-details-description";
      text.textContent = description;
      this.detailsEl.appendChild(text);
    }

    const fields: Array<[string, string]> = [["id", layer.id], ["category", layer.category], ["kind", layer.kind]];
    if (layer.aliases?.length) fields.push(["aliases", layer.aliases.join(", ")]);
    for (const source of layer.sources) {
      if (source.provenance?.provider) fields.push(["provider", source.provenance.provider]);
      for (const [key, value] of Object.entries(source.provenance?.identifiers ?? {})) fields.push([key, value]);
      if (source.temporal?.mode) {
        fields.push(["temporal", [source.temporal.mode, source.temporal.cadence].filter(Boolean).join(" · ")]);
      }
      const variables = sourceVariables(source);
      if (variables.length) fields.push(["variables", variables.join(", ")]);
      fields.push(["source", source.type]);
    }

    const grid = document.createElement("div");
    grid.className = "catalog-details-grid";
    for (const [label, value] of fields) {
      const key = document.createElement("span");
      key.className = "catalog-details-label";
      key.textContent = label;
      const val = document.createElement("span");
      val.className = "catalog-details-value";
      val.textContent = value;
      val.title = value;
      grid.append(key, val);
    }
    this.detailsEl.appendChild(grid);
  }
}

export function addCatalogPickerBlade(folder: FolderApi, options: CatalogPickerOptions): CatalogPickerBlade {
  const picker = new CatalogPicker(options);
  return { picker, blade: addDomBlade(folder, picker.element) };
}
