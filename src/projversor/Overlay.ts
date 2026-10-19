import {
  geoGraticule10,
  geoPath,
  geoProjectionMutator,
  type GeoPermissibleObjects,
  type GeoProjection,
  type GeoRawProjection,
} from "d3";
import { blendRaw, invertBlend, type Blend } from "./projections";
import { viewArea, type ViewFrame } from "./view";

export interface OverlayLayers {
  land: GeoPermissibleObjects;
  /** Finer land drawn once the view rests. */
  landDetail?: GeoPermissibleObjects;
}

/** Overlay colors, read from the matching css custom properties. */
const COLOR_TOKENS = [
  "ocean",
  "land",
  "coast",
  "outline",
  "graticule",
  "equator",
] as const;

const SPHERE: GeoPermissibleObjects = { type: "Sphere" };
const GRATICULE = geoGraticule10();
const EQUATOR: GeoPermissibleObjects = {
  type: "LineString",
  coordinates: [
    [-180, 0],
    [-90, 0],
    [0, 0],
    [90, 0],
    [180, 0],
  ],
};

/**
 * The d3 side of the blended projection: the sphere backdrop under the GL
 * canvas, land and lines above it. Also the source of `invert` for dragging.
 */
export class Overlay {
  readonly projection: GeoProjection;
  private blend: Blend | null = null;
  private readonly mutate: () => GeoProjection;
  private readonly back: CanvasRenderingContext2D;
  private readonly front: CanvasRenderingContext2D;
  /** Opaque land; off when the field also covers the continents. */
  fillLand = true;
  private readonly colors: Record<(typeof COLOR_TOKENS)[number], string>;

  constructor(
    backCanvas: HTMLCanvasElement,
    frontCanvas: HTMLCanvasElement,
    private readonly layers: OverlayLayers,
  ) {
    this.back = backCanvas.getContext("2d")!;
    this.front = frontCanvas.getContext("2d")!;
    const style = getComputedStyle(frontCanvas);
    this.colors = Object.fromEntries(
      COLOR_TOKENS.map((token) => [
        token,
        style.getPropertyValue(`--${token}`).trim(),
      ]),
    ) as Record<(typeof COLOR_TOKENS)[number], string>;
    this.mutate = geoProjectionMutator(() => {
      const blend = this.blend;
      if (!blend) {
        return ((x: number, y: number) => [x, y]) as GeoRawProjection;
      }
      const raw = blendRaw(blend) as GeoRawProjection;
      raw.invert = (x: number, y: number) =>
        invertBlend(blend, x, y) ?? [NaN, NaN];
      return raw;
    });
    this.projection = this.mutate();
  }

  /** Finer land, once loaded: drawn from the next resting frame. */
  setLandDetail(land: GeoPermissibleObjects): void {
    this.layers.landDetail = land;
  }

  /** Sync the d3 projection with a frame; cheap enough for every frame. */
  setView(frame: ViewFrame): GeoProjection {
    const { cx, cy } = viewArea(frame);
    this.blend = { ...frame.blend };
    this.mutate();
    return this.projection
      .rotate(frame.rotate)
      .scale(frame.zoom)
      .translate([cx, cy])
      .clipAngle(
        frame.clipAngle >= 180 ? (null as unknown as number) : frame.clipAngle,
      )
      .precision(0.4);
  }

  draw(frame: ViewFrame, dpr: number, detailed: boolean): void {
    this.setView(frame);
    const { width, height } = frame;
    for (const ctx of [this.back, this.front]) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
    }

    const back = geoPath(this.projection, this.back);
    this.back.beginPath();
    back(SPHERE);
    this.back.fillStyle = this.colors.ocean;
    this.back.fill();

    const ctx = this.front;
    const path = geoPath(this.projection, ctx);
    const land =
      detailed && this.layers.landDetail
        ? this.layers.landDetail
        : this.layers.land;

    ctx.beginPath();
    path(GRATICULE);
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = this.colors.graticule;
    ctx.stroke();

    ctx.beginPath();
    path(land);
    if (this.fillLand) {
      ctx.fillStyle = this.colors.land;
      ctx.fill();
    }
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = this.colors.coast;
    ctx.stroke();

    ctx.beginPath();
    path(EQUATOR);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = this.colors.equator;
    ctx.stroke();

    ctx.beginPath();
    path(SPHERE);
    ctx.lineWidth = 1;
    ctx.strokeStyle = this.colors.outline;
    ctx.stroke();
  }
}
