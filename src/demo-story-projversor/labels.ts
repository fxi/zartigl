/** Interface text of the story controls, per locale. */
export interface StoryUiLabels {
  navigation: string;
  previous: string;
  next: string;
  play: string;
  pause: string;
  step: (index: number, name: string) => string;
  source: string;
  render: string;
  timeline: string;
  north: string;
  legend: (min: string, max: string, unit: string) => string;
}

const LABELS: Record<string, StoryUiLabels> = {
  en: {
    navigation: "Story steps",
    previous: "Previous step",
    next: "Next step",
    play: "Play the story",
    pause: "Pause the story",
    step: (index, name) => `Step ${index + 1}: ${name}`,
    source: "Source",
    render: "Rendered with",
    timeline: "Archive timeline",
    north: "North",
    legend: (min, max, unit) => `Color scale from ${min} to ${max} ${unit}`,
  },
  fr: {
    navigation: "Étapes du récit",
    previous: "Étape précédente",
    next: "Étape suivante",
    play: "Lancer le récit",
    pause: "Mettre le récit en pause",
    step: (index, name) => `Étape ${index + 1} : ${name}`,
    source: "Source",
    render: "Rendu avec",
    timeline: "Chronologie de l'archive",
    north: "Nord",
    legend: (min, max, unit) =>
      `Échelle de couleurs de ${min} à ${max} ${unit}`,
  },
};

export function storyUiLabels(locale: string): StoryUiLabels {
  return LABELS[locale] ?? LABELS[locale.split("-")[0]] ?? LABELS.en;
}
