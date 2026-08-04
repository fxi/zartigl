export type ScalarColorDomain = [number, number];

export function validateScalarColorDomain(
  domain: ScalarColorDomain | null,
): ScalarColorDomain | null {
  if (domain == null) return null;
  if (!Number.isFinite(domain[0]) || !Number.isFinite(domain[1]) || domain[0] >= domain[1]) {
    throw new RangeError("colorDomain must contain two finite, increasing values");
  }
  return [domain[0], domain[1]];
}
