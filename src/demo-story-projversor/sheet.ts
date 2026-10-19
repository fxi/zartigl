import "@fontsource-variable/inter-tight";
import "./sheet.css";
import storyJson from "./story.json";

/**
 * Contact sheet: every scene at one viewport size, as still iframes, to
 * review layouts at a glance. One viewport at a time keeps the WebGL
 * contexts under the browser limit (about 16).
 */
const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1440, height: 900 },
  landscape: { width: 844, height: 390 },
} as const;

type ViewportId = keyof typeof VIEWPORTS;

const root = document.getElementById("sheet")!;
const ref = <T extends Element>(name: string) =>
  root.querySelector<T>(`[data-ref="${name}"]`)!;
const grid = ref<HTMLElement>("grid");
const nav = ref<HTMLElement>("viewports");
const debug = ref<HTMLInputElement>("debug");
const french = ref<HTMLInputElement>("french");

const params = new URLSearchParams(location.search);
let viewport: ViewportId = (params.get("vp") as ViewportId | null) ?? "desktop";
if (!(viewport in VIEWPORTS)) {
  viewport = "desktop";
}
debug.checked = params.has("debug");
french.checked = params.get("lang") === "fr";

const buttons = (Object.keys(VIEWPORTS) as ViewportId[]).map((id) => {
  const button = document.createElement("button");
  button.type = "button";
  const { width, height } = VIEWPORTS[id];
  button.textContent = `${id} ${width}×${height}`;
  button.addEventListener("click", () => {
    viewport = id;
    render();
  });
  return [id, button] as const;
});
nav.append(...buttons.map(([, button]) => button));
debug.addEventListener("change", render);
french.addEventListener("change", render);
new ResizeObserver(() => scale()).observe(grid);

function render(): void {
  const next = new URLSearchParams({ vp: viewport });
  if (debug.checked) {
    next.set("debug", "");
  }
  if (french.checked) {
    next.set("lang", "fr");
  }
  history.replaceState(null, "", `?${next}`);
  for (const [id, button] of buttons) {
    button.setAttribute("aria-pressed", String(id === viewport));
  }
  const { width, height } = VIEWPORTS[viewport];
  grid.style.setProperty("--vw", String(width));
  grid.style.setProperty("--vh", String(height));
  const query = new URLSearchParams({ still: "" });
  if (debug.checked) {
    query.set("debug", "");
  }
  if (french.checked) {
    query.set("lang", "fr");
  }
  grid.replaceChildren(
    ...storyJson.scenes.map((scene, i) => {
      const figure = document.createElement("figure");
      const frame = document.createElement("iframe");
      frame.width = String(width);
      frame.height = String(height);
      frame.loading = "lazy";
      frame.title = scene.id;
      frame.src = `./index.html?${query}#s=${scene.id}&paused=1`;
      const caption = document.createElement("figcaption");
      caption.textContent = `${String(i + 1).padStart(2, "0")} · ${scene.id} · ${scene.layout}`;
      const box = document.createElement("div");
      box.className = "sheet-frame";
      box.append(frame);
      figure.append(box, caption);
      return figure;
    }),
  );
  scale();
}

/** Shrink each iframe to its column, keeping the real viewport inside. */
function scale(): void {
  const box = grid.querySelector(".sheet-frame");
  if (!box) {
    return;
  }
  const { width } = VIEWPORTS[viewport];
  grid.style.setProperty("--scale", String(box.clientWidth / width));
}

render();
