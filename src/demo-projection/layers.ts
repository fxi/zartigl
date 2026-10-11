import type { ParticleSettings } from "./scales";

/**
 * Demo sub-catalog: global vector GeoVideo archives of the zartigl catalog,
 * with the styling this projection demo gives them. Palettes start dark so
 * the bright trails read against the black background.
 */
export interface DemoLayer {
  /** zartigl catalog entry id. */
  entryId: string;
  label: string;
  palette: string;
  /** Draw land opaque: off for fields that also cover land. */
  fillLand: boolean;
  /** Overrides of the catalog entry `defaults.particles` (density, speed, fade). */
  particles?: Partial<ParticleSettings>;
}

export const DEMO_LAYERS: DemoLayer[] = [
  {
    entryId: "61a81ddd-6c8e-4020-a59f-06ef13a90419",
    label: "Ocean Velocity",
    palette: "plasma",
    fillLand: true,
  },
  {
    entryId: "72aa3549-8cdf-4275-b8f7-5b32ca40a3f2",
    label: "Surface Wind",
    palette: "plasma",
    fillLand: false,
    particles: { density: 0.01, speed: 0.6 },
  },
  {
    entryId: "88f00432-ffad-4ebd-85ac-9f8de1ee5213",
    label: "Stokes Drift",
    palette: "viridis",
    fillLand: true,
  },
  {
    entryId: "bb38fd23-b0b0-4cd0-b59d-0224be3052f9",
    label: "Primary Swell",
    palette: "thermal",
    fillLand: true,
  },
  {
    entryId: "40733539-e493-448e-80b5-2a7874f47b85",
    label: "Sea Ice Drift",
    palette: "ice",
    fillLand: true,
  },
];
