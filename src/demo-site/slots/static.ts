import type { HomeSlot, HomeText } from "../home";

type VideoSlot = Extract<HomeSlot, { type: "video" }>;
type ArticleSlot = Extract<HomeSlot, { type: "article" }>;

/** A promotional video: muted, inline, with controls. */
export function renderVideo(
  doc: Document,
  slot: VideoSlot,
  t: HomeText,
): HTMLElement {
  const root = doc.createElement("section");
  root.className = "zs-feature zs-video";
  const video = doc.createElement("video");
  video.src = slot.src;
  if (slot.poster) {
    video.poster = slot.poster;
  }
  video.controls = true;
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  const title = doc.createElement("h1");
  title.textContent = t.text(slot.title);
  root.append(video, title);
  if (slot.text) {
    const text = doc.createElement("p");
    text.textContent = t.text(slot.text);
    root.append(text);
  }
  return root;
}

/** A short static article: a title, paragraphs and an optional link. */
export function renderArticle(
  doc: Document,
  slot: ArticleSlot,
  t: HomeText,
): HTMLElement {
  const root = doc.createElement("article");
  root.className = "zs-feature zs-article";
  const title = doc.createElement("h1");
  title.textContent = t.text(slot.title);
  root.append(title);
  for (const paragraph of slot.paragraphs) {
    const p = doc.createElement("p");
    p.textContent = t.text(paragraph);
    root.append(p);
  }
  if (slot.link) {
    const a = doc.createElement("a");
    a.href = t.href(slot.link);
    a.textContent = t.text(slot.link.label);
    root.append(a);
  }
  return root;
}
