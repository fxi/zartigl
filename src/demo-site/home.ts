import { resolveLocalizedText, type LocalizedText } from "../story";

/**
 * The home page document: a stable frame (header, footer, labels) around one
 * featured slot. Changing the story of the month changes `featured` only.
 */
export interface HomeDocument {
  schemaVersion: 1;
  defaultLocale: string;
  locales: string[];
  title: LocalizedText;
  header: {
    brand: LocalizedText;
    /** Link of the brand; `{locale}` is replaced by the active locale. */
    href: string;
    menu: HomeLink[];
    search?: HomeLink;
  };
  featured: HomeSlot;
  /** Shown instead of a story when WebGL2 is not available. */
  fallback?: HomeSlot;
  footer: {
    about?: { text: LocalizedText; link?: HomeLink };
    columns: { title: LocalizedText; links: HomeLink[] }[];
    social: HomeLink[];
    legal: HomeLink[];
    copyright?: LocalizedText;
  };
  labels: Record<"top" | "bottom" | "loading" | "scroll", LocalizedText>;
}

export interface HomeLink {
  label: LocalizedText;
  /** `{locale}` is replaced by the active locale. */
  href: string;
}

export type HomeSlot =
  | { type: "story"; id: string }
  | {
      type: "video";
      src: string;
      poster?: string;
      title: LocalizedText;
      text?: LocalizedText;
    }
  | {
      type: "article";
      title: LocalizedText;
      paragraphs: LocalizedText[];
      link?: HomeLink;
    };

const SLOT_TYPES = ["story", "video", "article"];
/** A story folder name: `2026-11-planet`. */
const STORY_ID = /^[a-z0-9][a-z0-9-]*$/;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Invalid home document: ${message}`);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function checkText(value: unknown, path: string, locale: string): void {
  invariant(
    isRecord(value) && typeof value[locale] === "string",
    `${path}.${locale} must be a string`,
  );
}

function checkLink(value: unknown, path: string, locale: string): void {
  invariant(isRecord(value), `${path} must be an object`);
  checkText(value.label, `${path}.label`, locale);
  invariant(
    typeof value.href === "string" && /^(https?:\/\/|#)/.test(value.href),
    `${path}.href must be an http(s) or # link`,
  );
}

function checkLinks(value: unknown, path: string, locale: string): void {
  invariant(Array.isArray(value), `${path} must be a list`);
  value.forEach((link, i) => checkLink(link, `${path}[${i}]`, locale));
}

function checkSlot(value: unknown, path: string, locale: string): void {
  invariant(
    isRecord(value) && SLOT_TYPES.includes(String(value.type)),
    `${path}.type must be one of ${SLOT_TYPES.join(", ")}`,
  );
  if (value.type === "story") {
    invariant(
      typeof value.id === "string" && STORY_ID.test(value.id),
      `${path}.id must be a story folder name`,
    );
    return;
  }
  checkText(value.title, `${path}.title`, locale);
  if (value.type === "video") {
    invariant(typeof value.src === "string", `${path}.src is required`);
    return;
  }
  invariant(
    Array.isArray(value.paragraphs) && value.paragraphs.length > 0,
    `${path}.paragraphs must not be empty`,
  );
  value.paragraphs.forEach((p, i) =>
    checkText(p, `${path}.paragraphs[${i}]`, locale),
  );
  if (value.link !== undefined) {
    checkLink(value.link, `${path}.link`, locale);
  }
}

/** Validate a home document; throws on the first problem, with its path. */
export function parseHome(value: unknown): HomeDocument {
  invariant(isRecord(value), "must be an object");
  invariant(value.schemaVersion === 1, "schemaVersion must be 1");
  const locale = value.defaultLocale;
  invariant(typeof locale === "string", "defaultLocale is required");
  invariant(
    Array.isArray(value.locales) && value.locales.includes(locale),
    "locales must include defaultLocale",
  );
  checkText(value.title, "title", locale);
  const { header, footer, labels } = value;
  invariant(isRecord(header), "header must be an object");
  checkText(header.brand, "header.brand", locale);
  invariant(
    typeof header.href === "string" && /^https?:\/\//.test(header.href),
    "header.href must be an http(s) url: it sets the site origin",
  );
  checkLinks(header.menu, "header.menu", locale);
  if (header.search !== undefined) {
    checkLink(header.search, "header.search", locale);
  }
  checkSlot(value.featured, "featured", locale);
  if (value.fallback !== undefined) {
    checkSlot(value.fallback, "fallback", locale);
    invariant(
      (value.fallback as HomeSlot).type !== "story",
      "fallback cannot be a story",
    );
  }
  invariant(isRecord(footer), "footer must be an object");
  if (footer.about !== undefined) {
    invariant(isRecord(footer.about), "footer.about must be an object");
    checkText(footer.about.text, "footer.about.text", locale);
    if (footer.about.link !== undefined) {
      checkLink(footer.about.link, "footer.about.link", locale);
    }
  }
  invariant(Array.isArray(footer.columns), "footer.columns must be a list");
  footer.columns.forEach((column, i) => {
    invariant(isRecord(column), `footer.columns[${i}] must be an object`);
    checkText(column.title, `footer.columns[${i}].title`, locale);
    checkLinks(column.links, `footer.columns[${i}].links`, locale);
  });
  checkLinks(footer.social, "footer.social", locale);
  checkLinks(footer.legal, "footer.legal", locale);
  if (footer.copyright !== undefined) {
    checkText(footer.copyright, "footer.copyright", locale);
  }
  invariant(isRecord(labels), "labels must be an object");
  for (const key of ["top", "bottom", "loading", "scroll"]) {
    checkText(labels[key], `labels.${key}`, locale);
  }
  return value as unknown as HomeDocument;
}

/**
 * The slot to render: the featured one, unless it is a story and WebGL2 is
 * missing (or `forceFallback`); then the fallback, when there is one.
 */
export function selectSlot(
  home: HomeDocument,
  webgl: boolean,
  forceFallback = false,
): HomeSlot {
  const needsFallback =
    forceFallback || (home.featured.type === "story" && !webgl);
  return needsFallback && home.fallback ? home.fallback : home.featured;
}

/** The first supported locale among the requested ones, else the default. */
export function selectLocale(
  home: HomeDocument,
  requested: readonly (string | null | undefined)[],
): string {
  for (const language of requested) {
    if (!language) {
      continue;
    }
    for (const candidate of [language, language.split("-")[0]]) {
      if (home.locales.includes(candidate)) {
        return candidate;
      }
    }
  }
  return home.defaultLocale;
}

/** Text and links of a home document in one locale. */
export interface HomeText {
  locale: string;
  text(value: LocalizedText): string;
  href(link: HomeLink | string): string;
  /** Outside the site: another origin than the brand link. */
  external(href: string): boolean;
}

export function homeText(home: HomeDocument, locale: string): HomeText {
  const href = (link: HomeLink | string) =>
    (typeof link === "string" ? link : link.href)
      .split("{locale}")
      .join(locale);
  const site = new URL(href(home.header.href)).origin;
  return {
    locale,
    text: (value) => resolveLocalizedText(value, locale, home.defaultLocale),
    href,
    external: (value) => {
      try {
        return new URL(value).origin !== site;
      } catch {
        return false;
      }
    },
  };
}

/** Url of a file of story `id`, under the content root. */
export function storyFile(contentUrl: URL, id: string, file: string): URL {
  return new URL(`stories/${id}/${file}`, contentUrl);
}
