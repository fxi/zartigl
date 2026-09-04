export const MOBILE_BREAKPOINT_PX = 850;

export function mobileMediaQuery(): MediaQueryList {
  return matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`);
}
