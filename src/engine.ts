/**
 * MapLibre-free rendering primitives: GeoVideo archives, manifests and frame
 * decoding, color ramps, trail fading and WebGL helpers. Published as
 * `@fxi/zartigl/engine` for renderers that own their projection and canvas.
 */
export {
  geoVideoChunkSources,
  isGeoVideoArchiveSource,
  loadGeoVideoIndex,
  validateGeoVideoIndex,
} from "./lib/geovideo-index";
export type { GeoVideoIndex, GeoVideoIndexChunk } from "./lib/geovideo-index";
export {
  geoVideoTimelineValues,
  loadGeoVideoManifest,
  validateGeoVideoManifest,
} from "./lib/geovideo";
export type {
  GeoVideoBounds,
  GeoVideoManifest,
  GeoVideoScalarEncoding,
  GeoVideoVectorEncoding,
} from "./lib/geovideo";
export { GeoVideoFrameSource } from "./lib/GeoVideoFrameSource";
export { GeoVideoScalarSource } from "./lib/GeoVideoScalarSource";
export { GeoVideoVectorSource } from "./lib/GeoVideoVectorSource";
export type { GeoVideoVectorFrame } from "./lib/GeoVideoVectorSource";
export {
  createColorRampTexture,
  createProgram,
  getPalettes,
  resolveColorRamp,
} from "./lib/gl-util";
export type { ColorRampInput, PaletteMeta } from "./lib/gl-util";
export { validateScalarColorDomain } from "./lib/scalar-color-domain";
export type { ScalarColorDomain } from "./lib/scalar-color-domain";
export { TrailFade, fadeToFrames, fadeToOpacity } from "./lib/trail-fade";
export {
  COLOR_GRADE_OFF,
  COLOR_GRADE_VIBRANT,
  colorGradeToGrade,
  gradeToColorGrade,
  colorGradeVec4,
  resolveColorGrade,
} from "./lib/color-grade";
export type { ColorGrade } from "./lib/color-grade";
export {
  BACKDROP_OFF,
  backdropVec4,
  isHexColor,
  resolveBackdrop,
} from "./lib/backdrop";
export { nextChunk, pairChunk } from "./lib/archive-timeline";
