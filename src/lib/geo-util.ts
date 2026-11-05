const MAX_MERCATOR_LAT = 85;
const MAX_GLOBE_LAT = 89.9;

export interface GeographicBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

interface BoundsLike {
  getWest(): number;
  getEast(): number;
  getNorth(): number;
  getSouth(): number;
}

function clampLatitude(lat: number): number {
  return Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
}

export function latToMercY(lat: number): number {
  const clamped = clampLatitude(lat);
  const sinLat = Math.sin((clamped * Math.PI) / 180);
  return 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
}

export function lngToMercX(lng: number): number {
  return (lng + 180) / 360;
}

export function normalizeLongitude(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/**
 * Outer edges of the cells between two indices of each coordinate axis
 * (cell centres), as GeoVideo and projversor bound their textures: texel i
 * then covers [edge + i·step, edge + (i+1)·step]. A global grid's edges span
 * 360°, so it meets itself at the date line. Latitude edges may pass the
 * poles by half a cell; shaders clamp them.
 */
export function cellEdgeBounds(
  longitude: ArrayLike<number>,
  latitude: ArrayLike<number>,
  lon: [number, number],
  lat: [number, number],
): GeographicBounds {
  const halfStep = (axis: ArrayLike<number>, first: number, last: number) => {
    if (last > first) {
      return Math.abs(axis[last] - axis[first]) / (last - first) / 2;
    }
    return axis.length > 1 ? Math.abs(axis[1] - axis[0]) / 2 : 0;
  };
  const halfLon = halfStep(longitude, lon[0], lon[1]);
  const halfLat = halfStep(latitude, lat[0], lat[1]);
  return {
    west: longitude[lon[0]] - halfLon,
    east: longitude[lon[1]] + halfLon,
    south: Math.min(latitude[lat[0]], latitude[lat[1]]) - halfLat,
    north: Math.max(latitude[lat[0]], latitude[lat[1]]) + halfLat,
  };
}

interface ProjectionLike {
  getProjection?: () => { type?: unknown } | undefined;
}

/**
 * Whether MapLibre draws the globe in this frame. A globe projection flattens
 * to Mercator at high zoom (`projectionTransition` 0): custom layers then get
 * Mercator matrices and must take their Mercator path. Without a transition
 * value (outside render, older engines), the projection type decides.
 */
export function rendersGlobe(
  map: ProjectionLike,
  projectionData?: { projectionTransition?: number },
): boolean {
  if (map.getProjection?.()?.type !== "globe") {
    return false;
  }
  const transition = projectionData?.projectionTransition;
  return typeof transition === "number" ? transition > 0 : true;
}

export function globeCenterVector(
  lng: number,
  lat: number,
): [number, number, number] {
  const lngRad = (normalizeLongitude(lng) * Math.PI) / 180;
  const latRad = (lat * Math.PI) / 180;
  const cosLat = Math.cos(latRad);
  return [
    Math.sin(lngRad) * cosLat,
    Math.sin(latRad),
    Math.cos(lngRad) * cosLat,
  ];
}

export function viewportMercatorBounds(
  bounds: BoundsLike,
  options: { wrapX?: boolean } = {},
): { minX: number; minY: number; maxX: number; maxY: number } {
  const west = options.wrapX
    ? Math.max(bounds.getWest(), -180)
    : bounds.getWest();
  const east = options.wrapX
    ? Math.min(bounds.getEast(), 180)
    : bounds.getEast();
  return {
    minX: lngToMercX(west),
    minY: latToMercY(bounds.getNorth()),
    maxX: lngToMercX(east),
    maxY: latToMercY(bounds.getSouth()),
  };
}

export function viewportGeoBounds(bounds: BoundsLike): GeographicBounds {
  return {
    west: -180,
    east: 180,
    south: clampLatitude(bounds.getSouth()),
    north: clampLatitude(bounds.getNorth()),
  };
}

export function paddedViewportGeoBounds(
  bounds: BoundsLike,
  paddingFactor = 1,
  isGlobe = false,
): GeographicBounds {
  const maxLat = isGlobe ? MAX_GLOBE_LAT : MAX_MERCATOR_LAT;
  const clamp = (lat: number) => Math.max(-maxLat, Math.min(maxLat, lat));
  const south = clamp(bounds.getSouth());
  const north = clamp(bounds.getNorth());
  const height = Math.max(0, north - south);
  const padding = height * Math.max(0, paddingFactor);
  return {
    west: -180,
    east: 180,
    south: clamp(south - padding),
    north: clamp(north + padding),
  };
}

export function coversViewportLatitude(
  coverage: GeographicBounds,
  viewport: GeographicBounds,
  epsilon = 1e-6,
): boolean {
  return (
    coverage.south <= viewport.south + epsilon &&
    coverage.north >= viewport.north - epsilon
  );
}

export function particleUpdateBounds(
  bounds: BoundsLike,
  isGlobe = false,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const west = bounds.getWest();
  const east = bounds.getEast();
  const rawMinX = lngToMercX(west);
  const rawMaxX = lngToMercX(east);
  // minX is wrapped into [0, 1) and maxX = minX + span, so a view crossing
  // the date line keeps its own span (maxX > 1); the update shader wraps it.
  const minX = rawMinX - Math.floor(rawMinX);
  const xBounds =
    rawMaxX - rawMinX >= 1
      ? { minX: 0, maxX: 1 }
      : { minX, maxX: minX + rawMaxX - rawMinX };

  if (isGlobe) {
    // Globe mode: particle Y encodes latitude as (lat+90)/180, covering full ±90°.
    return {
      ...xBounds,
      minY: (Math.max(bounds.getSouth(), -90) + 90) / 180,
      maxY: (Math.min(bounds.getNorth(), 90) + 90) / 180,
    };
  }

  return {
    ...xBounds,
    minY: latToMercY(bounds.getNorth()),
    maxY: latToMercY(bounds.getSouth()),
  };
}

export function visibleWorldCopyOffsets(
  bounds: BoundsLike,
  isGlobe: boolean,
): number[] {
  if (isGlobe) {
    return [0];
  }

  const rawMinX = lngToMercX(bounds.getWest());
  const rawMaxX = lngToMercX(bounds.getEast());
  const offsets: number[] = [];
  for (let n = Math.floor(rawMinX); n <= Math.floor(rawMaxX); n++) {
    offsets.push(n);
  }
  return offsets;
}
