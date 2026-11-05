/**
 * Axis ticks, axis titles and region names of the 3D view, as DOM text at
 * projected anchors (crisp at any pixel ratio). Ticks follow the bottom edges
 * that face the viewer; a group whose edge collapses on screen is hidden.
 */

import { NINO34, latLabel, lonLabel } from "../data/box";
import { project, type Frame, type Vec3 } from "../gl/camera";
import { CubeRenderer, LineBatch } from "../gl/renderer";
import { BOTTOM, toWorld, type Space } from "../gl/space";

type Align = "left" | "right" | "below" | "above" | "center" | "under";

const SHIFT: Record<Align, string> = {
  left: "translate(calc(-100% - 6px), -50%)",
  right: "translate(6px, -50%)",
  below: "translate(-50%, 6px)",
  above: "translate(-50%, calc(-100% - 4px))",
  center: "translate(-50%, -50%)",
  // Axis title, clear of the tick labels.
  under: "translate(-50%, 24px)",
};

interface Label {
  node: HTMLElement;
  group: string;
  at: () => Vec3;
  align: () => Align;
}

const LON_TICKS = [120, 140, 160, 180, 200, 220, 240, 260, 280];
const LAT_TICKS = [-10, -5, 0, 5, 10, 15];
const DEPTH_TICKS = [0, 50, 100, 150, 200, 250, 300];
const TICK = 0.025;

export class Labels {
  readonly element: HTMLElement;
  private labels: Label[] = [];
  /** Which bottom edges carry the ticks: the south (or north) and east (or west) ones. */
  private side = { y: -1, x: 1 };

  constructor(private space: Space) {
    this.element = document.createElement("div");
    this.element.className = "cube-labels";
    this.element.setAttribute("aria-hidden", "true");
    const [, hy, hz] = space.half;
    // Every second tick is "minor": hidden when its edge is short on screen.
    for (const [i, lon] of LON_TICKS.entries()) {
      this.add(
        lonLabel(lon),
        i % 2 ? "lon-minor" : "lon",
        "tick",
        () => {
          const p = toWorld(space, lon, 0, BOTTOM);
          return [p[0], this.side.y * (hy + TICK * 2), -hz];
        },
        () => "below",
      );
    }
    for (const [i, lat] of LAT_TICKS.entries()) {
      this.add(
        latLabel(lat),
        i % 2 ? "lat-minor" : "lat",
        "tick",
        () => {
          const p = toWorld(space, space.west, lat, BOTTOM);
          return [this.side.x * (space.half[0] + TICK * 2), p[1], -hz];
        },
        () => (this.side.x > 0 ? "right" : "left"),
      );
    }
    for (const depth of DEPTH_TICKS) {
      this.add(
        `${depth}`,
        "depth",
        "tick",
        () => {
          const p = toWorld(space, space.west, 0, depth);
          return [
            -this.side.x * (space.half[0] + TICK * 2),
            this.side.y * hy,
            p[2],
          ];
        },
        () => (this.side.x > 0 ? "left" : "right"),
      );
    }
    this.add(
      "LONGITUDE",
      "lon",
      "axis",
      () => [0, this.side.y * (hy + TICK * 2), -hz],
      () => "under",
    );
    // Latitude ticks carry N / S: no title, which would leave the frame on narrow views.
    this.add(
      "DEPTH (m)",
      "depth",
      "axis",
      () => [-this.side.x * space.half[0], this.side.y * hy, hz + 0.08],
      () => "above",
    );
    this.add(
      "PACIFIC OCEAN",
      "top",
      "feature",
      () => toWorld(space, 145, 10, 0),
      () => "center",
    );
    this.add(
      "NIÑO 3.4 BOX",
      "roi",
      "feature",
      () => toWorld(space, (NINO34.west + NINO34.east) / 2, NINO34.north, 0),
      () => "above",
    );
  }

  private add(
    text: string,
    group: string,
    kind: string,
    at: () => Vec3,
    align: () => Align,
  ): void {
    const node = document.createElement("span");
    node.className = `cube-label is-${kind}`;
    node.textContent = text;
    this.element.append(node);
    this.labels.push({ node, group, at, align });
  }

  /** Tick marks along the edges that carry the labels. */
  ticks(): LineBatch {
    const { space } = this;
    const [hx, hy, hz] = space.half;
    const batch = new LineBatch();
    for (const lon of LON_TICKS) {
      const [x] = toWorld(space, lon, 0, 0);
      batch.segment(
        [x, this.side.y * hy, -hz],
        [x, this.side.y * (hy + TICK), -hz],
      );
    }
    for (const lat of LAT_TICKS) {
      const [, y] = toWorld(space, space.west, lat, 0);
      batch.segment(
        [this.side.x * hx, y, -hz],
        [this.side.x * (hx + TICK), y, -hz],
      );
    }
    for (const depth of DEPTH_TICKS) {
      const [, , z] = toWorld(space, space.west, 0, depth);
      batch.segment(
        [-this.side.x * hx, this.side.y * hy, z],
        [-this.side.x * (hx + TICK), this.side.y * hy, z],
      );
    }
    return batch;
  }

  /** Moves the labels; returns true when the tick edges changed (ticks to rebuild). */
  update(
    frame: Frame,
    width: number,
    height: number,
    show: { roi: boolean },
  ): boolean {
    const side = {
      y: CubeRenderer.faces([0, -1, 0], frame.ray) ? -1 : 1,
      x: CubeRenderer.faces([1, 0, 0], frame.ray) ? 1 : -1,
    };
    const changed = side.x !== this.side.x || side.y !== this.side.y;
    this.side = side;
    const [hx, hy, hz] = this.space.half;
    // Screen length of each group's edge: a collapsed edge hides its labels.
    const length = (a: Vec3, b: Vec3) => {
      const [ax, ay] = project(frame, a, width, height);
      const [bx, by] = project(frame, b, width, height);
      return Math.hypot(bx - ax, by - ay);
    };
    const lonEdge = length([-hx, side.y * hy, -hz], [hx, side.y * hy, -hz]);
    const latEdge = length([side.x * hx, -hy, -hz], [side.x * hx, hy, -hz]);
    const visible: Record<string, boolean> = {
      lon: lonEdge > 120,
      "lon-minor": lonEdge > 560,
      lat: latEdge > 70,
      "lat-minor": latEdge > 150,
      depth:
        length(
          [-side.x * hx, side.y * hy, -hz],
          [-side.x * hx, side.y * hy, hz],
        ) > 70,
      top:
        CubeRenderer.faces([0, 0, 1], frame.ray) &&
        length([-hx, -hy, hz], [-hx, hy, hz]) > 60,
      roi: show.roi,
    };
    for (const label of this.labels) {
      if (!visible[label.group]) {
        label.node.style.opacity = "0";
        continue;
      }
      const [x, y] = project(frame, label.at(), width, height);
      label.node.style.opacity = "1";
      label.node.style.transform = `translate(${x}px, ${y}px) ${SHIFT[label.align()]}`;
    }
    return changed;
  }
}
