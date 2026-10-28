/** Index of the step at or before `ms` and the fraction toward the next. */
export function timeBracket(
  times: ArrayLike<number>,
  ms: number,
): { index: number; fraction: number } {
  if (ms <= times[0]) {
    return { index: 0, fraction: 0 };
  }
  const last = times.length - 1;
  if (ms >= times[last]) {
    return { index: last, fraction: 0 };
  }
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= ms) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return { index: lo, fraction: (ms - times[lo]) / (times[hi] - times[lo]) };
}

/** Fractional step corresponding to a time. */
export function timeStep(times: ArrayLike<number>, ms: number): number {
  const { index, fraction } = timeBracket(times, ms);
  return index + fraction;
}

/** Time at a fractional step, clamped to the available samples. */
export function stepTime(times: ArrayLike<number>, step: number): number {
  const index = Math.max(0, Math.min(times.length - 1, Math.floor(step)));
  const next = Math.min(index + 1, times.length - 1);
  return (
    times[index] + (times[next] - times[index]) * Math.max(0, step - index)
  );
}
