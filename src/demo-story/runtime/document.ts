import type {
  LocalizedText,
  StoryBlock,
  StoryDocument,
  StoryScene,
  StoryViewsDocument,
} from "./types";

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid story document: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateLocalized(value: unknown, path: string, defaultLocale: string): void {
  invariant(isRecord(value), `${path} must be a localized object`);
  invariant(typeof value[defaultLocale] === "string", `${path}.${defaultLocale} must be a string`);
}

function validateHttpUrl(value: unknown, path: string): void {
  invariant(typeof value === "string", `${path} must be a string`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid story document: ${path} must be a valid URL`);
  }
  invariant(url.protocol === "https:" || url.protocol === "http:", `${path} must use HTTP or HTTPS`);
}

function validateBlock(block: unknown, path: string, defaultLocale: string): asserts block is StoryBlock {
  invariant(isRecord(block), `${path} must be an object`);
  invariant(typeof block.id === "string" && block.id.length > 0, `${path}.id is required`);
  invariant(["copy", "stage", "analysis", "edge"].includes(String(block.slot)), `${path}.slot is invalid`);
  invariant(["copy", "view", "widget", "text", "credit", "label"].includes(String(block.type)), `${path}.type is invalid`);
  if (block.type === "copy") {
    validateLocalized(block.heading, `${path}.heading`, defaultLocale);
    if (block.text !== undefined) validateLocalized(block.text, `${path}.text`, defaultLocale);
    if (block.references !== undefined) {
      invariant(Array.isArray(block.references) && block.references.length > 0, `${path}.references must not be empty`);
      block.references.forEach((reference, index) => {
        const referencePath = `${path}.references[${index}]`;
        invariant(isRecord(reference), `${referencePath} must be an object`);
        validateLocalized(reference.label, `${referencePath}.label`, defaultLocale);
        validateHttpUrl(reference.url, `${referencePath}.url`);
      });
    }
    if (block.backdrop !== undefined) {
      invariant(["none", "dark-gradient"].includes(String(block.backdrop)), `${path}.backdrop is invalid`);
    }
  }
  if (block.type === "view") invariant(typeof block.view === "string", `${path}.view is required`);
  if (block.type === "widget") {
    invariant(typeof block.widget === "string", `${path}.widget is required`);
    if (block.caption !== undefined) validateLocalized(block.caption, `${path}.caption`, defaultLocale);
  }
  if (["text", "credit", "label"].includes(String(block.type))) {
    validateLocalized(block.text, `${path}.text`, defaultLocale);
  }
}

export function validateStoryDocument(value: unknown): asserts value is StoryDocument {
  invariant(isRecord(value), "root must be an object");
  invariant(value.schemaVersion === 1, "schemaVersion must be 1");
  invariant(typeof value.defaultLocale === "string", "defaultLocale is required");
  const locale = value.defaultLocale;
  validateLocalized(value.title, "title", locale);
  invariant(isRecord(value.themes) && Object.keys(value.themes).length > 0, "themes must not be empty");
  invariant(Array.isArray(value.scenes) && value.scenes.length > 0, "scenes must not be empty");
  const sceneIds = new Set<string>();
  for (const [index, sceneValue] of value.scenes.entries()) {
    const path = `scenes[${index}]`;
    invariant(isRecord(sceneValue), `${path} must be an object`);
    invariant(typeof sceneValue.id === "string" && sceneValue.id.length > 0, `${path}.id is required`);
    invariant(!sceneIds.has(sceneValue.id), `${path}.id is duplicated`);
    sceneIds.add(sceneValue.id);
    invariant(typeof sceneValue.theme === "string" && sceneValue.theme in value.themes, `${path}.theme is unknown`);
    invariant(["full", "split-left", "split-right", "overlay"].includes(String(sceneValue.layout)), `${path}.layout is invalid`);
    validateLocalized(sceneValue.name, `${path}.name`, locale);
    invariant(Array.isArray(sceneValue.blocks), `${path}.blocks must be an array`);
    invariant(!("scrollVh" in sceneValue), `${path}.scrollVh is not supported by scene navigation`);
    if (sceneValue.playback !== undefined) {
      invariant(isRecord(sceneValue.playback), `${path}.playback must be an object`);
      invariant(["none", "autoplay", "sequence"].includes(String(sceneValue.playback.mode)), `${path}.playback.mode is invalid`);
      if (sceneValue.playback.mode === "sequence") {
        invariant(Array.isArray(sceneValue.playback.times) && sceneValue.playback.times.length > 0, `${path}.playback.times must not be empty`);
        invariant(sceneValue.playback.times.every((time) => typeof time === "string" && Number.isFinite(Date.parse(time))), `${path}.playback.times contains an invalid date`);
        invariant(typeof sceneValue.playback.intervalMs === "number" && sceneValue.playback.intervalMs > 0, `${path}.playback.intervalMs must be positive`);
      }
    }
    const blockIds = new Set<string>();
    sceneValue.blocks.forEach((block, blockIndex) => {
      validateBlock(block, `${path}.blocks[${blockIndex}]`, locale);
      invariant(!blockIds.has(block.id), `${path}.blocks[${blockIndex}].id is duplicated`);
      blockIds.add(block.id);
    });
  }
}

export function validateViewsDocument(value: unknown): asserts value is StoryViewsDocument {
  invariant(isRecord(value), "views root must be an object");
  invariant(value.schemaVersion === 1, "views schemaVersion must be 1");
  invariant(Array.isArray(value.views), "views must be an array");
  const ids = new Set<string>();
  for (const [index, view] of value.views.entries()) {
    invariant(isRecord(view), `views[${index}] must be an object`);
    invariant(typeof view.id === "string" && view.id.length > 0, `views[${index}].id is required`);
    invariant(!ids.has(view.id), `views[${index}].id is duplicated`);
    ids.add(view.id);
    invariant(typeof view.type === "string" && view.type.length > 0, `views[${index}].type is required`);
    invariant(isRecord(view.config), `views[${index}].config must be an object`);
  }
}

export function validateStoryReferences(story: StoryDocument, views: StoryViewsDocument): void {
  const viewIds = new Set(views.views.map((view) => view.id));
  for (const scene of story.scenes) {
    for (const block of scene.blocks) {
      if (block.type === "view") invariant(viewIds.has(block.view), `scene ${scene.id} references unknown view ${block.view}`);
    }
  }
}

export function resolveLocalizedText(
  text: LocalizedText,
  locale: string,
  defaultLocale: string,
  fallbacks: readonly string[] = [],
): string {
  for (const candidate of [locale, ...fallbacks, defaultLocale]) {
    if (text[candidate]) return text[candidate];
  }
  return Object.values(text).find(Boolean) ?? "";
}

export function parseStoryDocuments(story: unknown, views: unknown): { story: StoryDocument; views: StoryViewsDocument } {
  validateStoryDocument(story);
  validateViewsDocument(views);
  validateStoryReferences(story, views);
  return { story, views };
}

export function sceneViewId(scene: StoryScene): string | undefined {
  return scene.blocks.find((block) => block.type === "view")?.view;
}
