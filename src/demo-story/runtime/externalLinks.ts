import type { StoryReference } from "./types";

export interface StoryExternalLinkAttributes {
  href: string;
  target: "_blank";
  rel: "noopener noreferrer";
  textContent: string;
}

export function storyExternalLinkAttributes(
  reference: StoryReference,
  label: string,
): StoryExternalLinkAttributes {
  return {
    href: reference.url,
    target: "_blank",
    rel: "noopener noreferrer",
    textContent: label,
  };
}
