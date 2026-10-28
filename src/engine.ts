/**
 * MapLibre-free rendering primitives: GeoVideo archives, manifests and frame
 * decoding, color ramps, color grade, backdrop, trail fading, WebGL helpers
 * and shared GLSL chunks. Published as `@fxi/zartigl/engine` for renderers
 * that own their projection and canvas, such as `@fxi/projversor`.
 */
export {
  assertGeoVideoIndexIdentity,
  geoVideoChunkSources,
  geoVideoIndexChunks,
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
export type { GeoVideoFrameRequest } from "./lib/GeoVideoFrameSource";
export {
  GeoVideoArchiveSource,
  createGeoVideoFrameSource,
  geoVideoGrid,
  nextChunkSpan,
  pairChunkSpan,
} from "./lib/GeoVideoArchiveSource";
export type {
  GeoVideoArchiveChunk,
  GeoVideoArchiveFrame,
  GeoVideoArchiveSample,
  GeoVideoArchiveSourceOptions,
  GeoVideoChunkSpan,
  GeoVideoFrameData,
  GeoVideoFrameReader,
  GeoVideoGrid,
  GeoVideoSampleMode,
} from "./lib/GeoVideoArchiveSource";
export {
  GeoVideoScalarSource,
  geoVideoScalarUniforms,
} from "./lib/GeoVideoScalarSource";
export type { GeoVideoScalarFrame } from "./lib/GeoVideoScalarSource";
export { GeoVideoVectorSource } from "./lib/GeoVideoVectorSource";
export type { GeoVideoVectorFrame } from "./lib/GeoVideoVectorSource";
export {
  alphaFadeAt,
  createColorRampTexture,
  createProgram,
  createShader,
  getPalettes,
  resolveColorRamp,
} from "./lib/gl-util";
export {
  COLOR_GRADE_GLSL,
  GEOVIDEO_SCALAR_GLSL,
  VELOCITY_BLEND_GLSL,
  RANDOM_GLSL,
  VIBRANCE_GLSL,
} from "./lib/glsl-chunks";
export type {
  AlphaFade,
  AlphaFadeCurve,
  ColorRampInput,
  PaletteMeta,
} from "./lib/gl-util";
export { validateScalarColorDomain } from "./lib/scalar-color-domain";
export type { ScalarColorDomain } from "./lib/scalar-color-domain";
export { TrailFade, fadeToFrames, fadeToOpacity } from "./lib/trail-fade";
export { formatUnit } from "./lib/units";
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
export {
  parseTimeRange,
  subtractIsoDuration,
  timeRangeBounds,
} from "./lib/time-range";
export type { TimeRange } from "./lib/time-range";
export { timeBracket, timeStep, stepTime } from "./lib/time-bracket";
export { GeoVideoClock } from "./lib/GeoVideoClock";
export { GeoVideoField, velocityTexels } from "./lib/GeoVideoField";
export type {
  GeoVideoProgram,
  GeoVideoFieldOptions,
  FieldUniforms,
} from "./lib/GeoVideoField";

export { GeoVideoPlayback } from "./lib/GeoVideoPlayback";
export type {
  GeoVideoPlaybackOptions,
  GeoVideoPlaybackReplaceOptions,
  GeoVideoPlaybackEvents,
} from "./lib/GeoVideoPlayback";
export type {
  VelocityTextureField,
  VelocityTexturePair,
} from "./lib/velocity-pair";
