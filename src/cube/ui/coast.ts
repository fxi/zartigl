/**
 * Coastlines inside the cube's horizontal extent, as polylines of
 * (unwrapped longitude, latitude). From Natural Earth 1:50m land via
 * world-atlas. Lines are cut where they leave the box or jump across the
 * meridian where the unwrapping restarts.
 */

import { mesh } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import land from "world-atlas/land-50m.json";
import { unwrap } from "../data/box";

export type Polyline = Array<[number, number]>;

export function coastlines(extent: {
  west: number;
  east: number;
  south: number;
  north: number;
}): Polyline[] {
  const topology = land as unknown as Topology<{ land: GeometryCollection }>;
  const lines = mesh(topology, topology.objects.land).coordinates as Array<
    Array<[number, number]>
  >;
  const inside = ([lon, lat]: [number, number]) =>
    lon >= extent.west &&
    lon <= extent.east &&
    lat >= extent.south &&
    lat <= extent.north;
  const result: Polyline[] = [];
  for (const line of lines) {
    let current: Polyline = [];
    let previous: [number, number] | null = null;
    for (const [lon, lat] of line) {
      const point: [number, number] = [unwrap(lon), lat];
      const jump = previous !== null && Math.abs(point[0] - previous[0]) > 180;
      if (!inside(point) || jump) {
        if (current.length > 1) {
          result.push(current);
        }
        current = inside(point) ? [point] : [];
      } else {
        current.push(point);
      }
      previous = point;
    }
    if (current.length > 1) {
      result.push(current);
    }
  }
  return result;
}
