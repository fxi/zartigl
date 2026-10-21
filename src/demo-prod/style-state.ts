import {
  diffStyle,
  mergeStyles,
  resolveEntryStyle,
  styleForKind,
  type CatalogEntry,
  type LayerStyle,
  type LayerStyleInput,
  type StyledEntry,
} from "../catalog";
import type { RenderMode } from "../lib";

/** Tweakpane fields showing a layer style. */
export interface StyleParams {
  palette: string;
  renderMode: RenderMode;
  particleDensity: number;
  speed: number;
  fade: number;
  /** Vibrant particle grade; a tuned grade shows as on. */
  vibrant: boolean;
  opacity: number;
  logScale: boolean;
  vibrance: number;
  colorDomain: [number, number] | null;
  colorDomainMin: number;
  colorDomainMax: number;
}

/** The Tweakpane fields of a resolved style. */
export function styleParams(style: LayerStyle): StyleParams {
  const { particles, raster } = style;
  return {
    palette: style.palette ?? "rdylbu",
    renderMode: style.renderMode,
    particleDensity: particles.density,
    speed: particles.speed,
    fade: particles.fade,
    vibrant: particles.grade !== "off",
    opacity: raster.opacity,
    logScale: raster.logScale,
    vibrance: raster.vibrance,
    colorDomain: raster.colorDomain,
    colorDomainMin: raster.colorDomain?.[0] ?? 0,
    colorDomainMax: raster.colorDomain?.[1] ?? 1,
  };
}

/** Style keys of a share link: `st`, else the first format's flat keys. */
export interface HashStyle {
  st?: LayerStyleInput;
  p?: string;
  pd?: number;
  sp?: number;
  f?: number;
  rm?: RenderMode;
  op?: number;
  ls?: boolean;
  vb?: number;
  cd?: [number, number] | null;
}

/** The style override a share link holds, for a layer of `kind`. */
export function hashStyle(
  hash: HashStyle,
  kind: CatalogEntry["kind"],
): LayerStyleInput {
  const style =
    hash.st ??
    mergeStyles({
      palette: hash.p,
      renderMode: hash.rm,
      particles: { density: hash.pd, speed: hash.sp, fade: hash.f },
      raster: {
        opacity: hash.op,
        logScale: hash.ls,
        vibrance: hash.vb,
        colorDomain: hash.cd,
      },
    });
  return styleForKind(style, kind);
}

/**
 * The override with a control's patch, or undefined when the patch changes
 * nothing the layer draws, as when a pane refresh echoes shown values.
 */
export function patchedStyle(
  override: LayerStyleInput,
  patch: LayerStyleInput,
  entry: StyledEntry,
): LayerStyleInput | undefined {
  const change = diffStyle(
    styleForKind(patch, entry.kind),
    resolveEntryStyle(entry, override),
  );
  return Object.keys(change).length ? mergeStyles(override, change) : undefined;
}
