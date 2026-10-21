/**
 * projversor: GeoVideo archives on a sphere that morphs between world
 * projections, independent of MapLibre. Published as `@fxi/zartigl/projversor`.
 */
export {
  Projversor,
  SPEEDS,
  TRANSITION_MS,
  VIEW_MS,
  clampZoom,
  isTintEntry,
} from "./Projversor";
export type {
  ProjversorCanvases,
  ProjversorEvents,
  ProjversorMonth,
  ProjversorViewTarget,
} from "./Projversor";
export { PRESETS, findPreset } from "./presets";
export type { Preset } from "./presets";
export { PROJECTIONS } from "./projections";
export type { ProjectionId } from "./projections";
export { NO_INSET, viewArea } from "./view";
export type { Inset } from "./view";
export {
  PROJVERSOR_LAYERS,
  TINT_LAYERS,
  findLayer,
  layerPalettes,
} from "./layers";
export type { ProjversorLayer } from "./layers";
export { decodeShare, encodeShare } from "./share";
export type { LegacyShareState, ShareState } from "./share";
export {
  chunkLabel,
  formatUnit,
  legendTicks,
  legendLabels,
  linearTicks,
  monthLegend,
  playheadLabel,
  rampGradient,
  rampPosition,
  timeTicks,
} from "./scales";
export type { LegendScale, TimeTick } from "./scales";
export { normalizeBearing, pointerBearing, screenNorth } from "./bearing";
export type { ScreenProjection } from "./bearing";
export type { GeoVideoField } from "./GeoVideoField";
export {
  ProjversorStoryView,
  parseProjversorView,
  projversorState,
} from "./storyView";
export type {
  ProjversorViewConfig,
  ProjversorViewDefinition,
} from "./storyView";
