/**
 * GODAS levels are 10 m apart down to 225 m, then wider. The cube draws depth
 * linearly, so each month is resampled onto a regular grid of `steps`
 * depths from 0 to `bottom` metres, interpolating between level centres.
 */

/** Depth of a regular grid step. */
export function gridDepth(step: number, steps: number, bottom: number): number {
  return (step / (steps - 1)) * bottom;
}

/** For each grid step, the two levels around it and the weight of the deeper one. */
export interface DepthWeights {
  upper: Int32Array;
  lower: Int32Array;
  weight: Float32Array;
}

/**
 * Above the first level centre (5 m) the first level is used as it is; below
 * the last, the last.
 */
export function depthWeights(
  levels: ArrayLike<number>,
  steps: number,
  bottom: number,
): DepthWeights {
  const upper = new Int32Array(steps);
  const lower = new Int32Array(steps);
  const weight = new Float32Array(steps);
  const last = levels.length - 1;
  let k = 0;
  for (let step = 0; step < steps; step++) {
    const depth = gridDepth(step, steps, bottom);
    if (depth <= levels[0]) {
      upper[step] = lower[step] = 0;
      continue;
    }
    if (depth >= levels[last]) {
      upper[step] = lower[step] = last;
      continue;
    }
    while (k < last - 1 && levels[k + 1] < depth) {
      k++;
    }
    upper[step] = k;
    lower[step] = k + 1;
    weight[step] = (depth - levels[k]) / (levels[k + 1] - levels[k]);
  }
  return { upper, lower, weight };
}

/**
 * Interpolated value of a column at a grid step; NaN when either level is
 * missing (below the sea floor), so the bottom is not extended.
 */
export function interpolate(
  upperValue: number,
  lowerValue: number,
  weight: number,
): number {
  if (weight === 0) {
    return upperValue;
  }
  return upperValue + (lowerValue - upperValue) * weight;
}
