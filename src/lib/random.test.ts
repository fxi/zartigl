import { describe, expect, it } from "vitest";
import randomGlsl from "./shaders/random.glsl?raw";

/** JS mirror of shaders/random.glsl. */
function pcg(v: number): number {
  const state = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(
    ((state >>> ((state >>> 28) + 4)) ^ state) >>> 0,
    277803737,
  );
  return ((word >>> 22) ^ word) >>> 0;
}

function random(x: number, y: number, z: number): number {
  return (pcg(x ^ pcg(y ^ pcg(z))) >>> 8) / 16777216;
}

/** The former hash, in float32: fract(sin(dot(co, k)) * 43758.5453). */
function sinHash(x: number, y: number): number {
  const f = Math.fround;
  const v = f(f(Math.sin(f(f(x * 12.9898) + f(y * 78.233)))) * 43758.5453);
  return f(v - Math.floor(v));
}

/** Distinct values among the draws that land below 0.01. */
function distinctBelow(values: number[]): number {
  const small = values.filter((v) => v < 0.01);
  return new Set(small).size / small.length;
}

describe("shader random hash", () => {
  it("is the PCG hash mirrored here", () => {
    expect(randomGlsl).toContain("uint pcg(uint v)");
    expect(randomGlsl).toContain("float random(uvec3 v)");
  });

  it("resolves small values that map near the projection center", () => {
    const hashed: number[] = [];
    const former: number[] = [];
    for (let frame = 0; frame < 4; frame++) {
      for (let y = 0; y < 256; y++) {
        for (let x = 0; x < 256; x++) {
          hashed.push(random(x, y, frame * 4 + 1));
          former.push(
            sinHash(
              ((x + 0.5) / 256) * 91.7 + 37 * frame + 3.7,
              ((y + 0.5) / 256) * 91.7 + 13 * frame + 1.9,
            ),
          );
        }
      }
    }
    expect(distinctBelow(hashed)).toBeGreaterThan(0.99);
    expect(distinctBelow(former)).toBeLessThan(0.2);
  });

  it("gives independent, uniform radius and azimuth streams", () => {
    const bins = 32;
    const counts = new Uint32Array(bins * bins);
    let n = 0;
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const r = random(x, y, 4 * 7 + 1);
        const a = random(x, y, 4 * 7 + 2);
        counts[Math.floor(a * bins) * bins + Math.floor(r * bins)]++;
        n++;
      }
    }
    const expected = n / counts.length;
    let chi = 0;
    for (const c of counts) {
      chi += (c - expected) ** 2 / expected;
    }
    expect(chi / (counts.length - 1)).toBeLessThan(1.15);
  });
});
