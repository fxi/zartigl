import type { HomeDocument, HomeLink, HomeText } from "./home";

/** The stable frame around the featured slot: header, footer, scroll buttons. */

function link(doc: Document, t: HomeText, item: HomeLink): HTMLAnchorElement {
  const a = doc.createElement("a");
  a.href = t.href(item);
  a.textContent = t.text(item.label);
  if (t.external(a.href)) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  return a;
}

function linkList(
  doc: Document,
  t: HomeText,
  items: readonly HomeLink[],
): HTMLUListElement {
  const ul = doc.createElement("ul");
  for (const item of items) {
    const li = doc.createElement("li");
    li.append(link(doc, t, item));
    ul.append(li);
  }
  return ul;
}

export function renderHeader(
  doc: Document,
  home: HomeDocument,
  t: HomeText,
  onLocale: (locale: string) => void,
): HTMLElement {
  const { header } = home;
  const root = doc.createElement("header");
  root.className = "zs-header";

  const brand = doc.createElement("a");
  brand.className = "zs-brand";
  brand.href = t.href(header.href);
  brand.textContent = t.text(header.brand);

  const nav = doc.createElement("nav");
  nav.className = "zs-menu";
  nav.setAttribute("aria-label", t.text(home.title));
  nav.append(linkList(doc, t, header.menu));

  const tools = doc.createElement("div");
  tools.className = "zs-tools";
  if (header.search) {
    const search = link(doc, t, header.search);
    search.className = "zs-search";
    tools.append(search);
  }
  for (const locale of home.locales) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "zs-locale";
    button.textContent = locale;
    button.lang = locale;
    button.setAttribute("aria-pressed", String(locale === t.locale));
    button.addEventListener("click", () => onLocale(locale));
    tools.append(button);
  }

  root.append(brand, nav, tools);
  return root;
}

export function renderFooter(
  doc: Document,
  home: HomeDocument,
  t: HomeText,
): HTMLElement {
  const { footer } = home;
  const root = doc.createElement("footer");
  root.className = "zs-footer";

  const grid = doc.createElement("div");
  grid.className = "zs-footer-grid";
  if (footer.about) {
    const about = doc.createElement("section");
    about.className = "zs-about";
    const p = doc.createElement("p");
    p.textContent = t.text(footer.about.text);
    about.append(p);
    if (footer.about.link) {
      about.append(link(doc, t, footer.about.link));
    }
    grid.append(about);
  }
  for (const column of footer.columns) {
    const section = doc.createElement("section");
    const title = doc.createElement("h2");
    title.textContent = t.text(column.title);
    section.append(title, linkList(doc, t, column.links));
    grid.append(section);
  }

  const bottom = doc.createElement("div");
  bottom.className = "zs-footer-bottom";
  const social = linkList(doc, t, footer.social);
  social.className = "zs-social";
  const legal = linkList(doc, t, footer.legal);
  legal.className = "zs-legal";
  bottom.append(social, legal);
  if (footer.copyright) {
    const copyright = doc.createElement("p");
    copyright.textContent = t.text(footer.copyright);
    bottom.append(copyright);
  }

  root.append(grid, bottom);
  return root;
}

/** Fixed buttons to the top of the site and to its footer. */
export function renderScrollNav(
  doc: Document,
  home: HomeDocument,
  t: HomeText,
  targets: { top: HTMLElement; bottom: HTMLElement },
): HTMLElement {
  const nav = doc.createElement("nav");
  nav.className = "zs-scroll-nav";
  const reduced = doc.defaultView?.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  const behavior: ScrollBehavior = reduced ? "auto" : "smooth";
  for (const [key, glyph] of [
    ["top", "↑"],
    ["bottom", "↓"],
  ] as const) {
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = glyph;
    const label = t.text(home.labels[key]);
    button.setAttribute("aria-label", label);
    button.title = label;
    button.addEventListener("click", () =>
      targets[key].scrollIntoView({
        behavior,
        block: key === "top" ? "start" : "end",
      }),
    );
    nav.append(button);
  }
  return nav;
}
