const MAX_MERCATOR_LAT = 85;

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

export function globeCenterVector(lng: number, lat: number): [number, number, number] {
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
  const west = options.wrapX ? Math.max(bounds.getWest(), -180) : bounds.getWest();
  const east = options.wrapX ? Math.min(bounds.getEast(), 180) : bounds.getEast();
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
): GeographicBounds {
  const south = clampLatitude(bounds.getSouth());
  const north = clampLatitude(bounds.getNorth());
  const height = Math.max(0, north - south);
  const padding = height * Math.max(0, paddingFactor);
  return {
    west: -180,
    east: 180,
    south: clampLatitude(south - padding),
    north: clampLatitude(north + padding),
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
): { minX: number; minY: number; maxX: number; maxY: number } {
  const west = bounds.getWest();
  const east = bounds.getEast();
  const rawMinX = lngToMercX(west);
  const rawMaxX = lngToMercX(east);
  const spansWorld = rawMaxX - rawMinX >= 1;
  const crossesWrappedWorld = Math.floor(rawMinX) !== Math.floor(rawMaxX);
  const xBounds = spansWorld || crossesWrappedWorld
    ? { minX: 0, maxX: 1 }
    : {
        minX: rawMinX - Math.floor(rawMinX),
        maxX: rawMaxX - Math.floor(rawMaxX),
      };

  return {
    ...xBounds,
    minY: latToMercY(bounds.getNorth()),
    maxY: latToMercY(bounds.getSouth()),
  };
}

export function visibleWorldCopyOffsets(bounds: BoundsLike, isGlobe: boolean): number[] {
  if (isGlobe) return [0];

  const rawMinX = lngToMercX(bounds.getWest());
  const rawMaxX = lngToMercX(bounds.getEast());
  const offsets: number[] = [];
  for (let n = Math.floor(rawMinX); n <= Math.floor(rawMaxX); n++) {
    offsets.push(n);
  }
  return offsets;
}
