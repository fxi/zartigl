const MAX_MERCATOR_LAT = 85;

export function latToMercY(lat: number): number {
  const clamped = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
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
  bounds: {
    getWest(): number;
    getEast(): number;
    getNorth(): number;
    getSouth(): number;
  },
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

export function particleUpdateBounds(
  bounds: {
    getWest(): number;
    getEast(): number;
    getNorth(): number;
    getSouth(): number;
  },
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
