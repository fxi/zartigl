/**
 * Optional color grade applied when particle trails are composited
 * (`shaders/color-grade.glsl`): more intense highlights, deeper shadows and
 * richer colors, without hard clipping. Off by default; when off, the
 * composite returns the trail colors unchanged.
 */
export interface ColorGrade {
  enabled: boolean;
  /** Mid-tone lift [0, 4]; 0 keeps the tones. */
  exposure: number;
  /** S-curve strength [0, 1]. */
  contrast: number;
  /** Vibrance-weighted saturation [-1, 1]. */
  saturation: number;
  /** Push of the bright half toward white [0, 1]. */
  highlights: number;
}

/** Tuned values for the vibrant look, disabled. */
const VIBRANT = {
  exposure: 0.8,
  contrast: 0.6,
  saturation: 0.4,
  highlights: 0.6,
} as const;

export const COLOR_GRADE_OFF: Readonly<ColorGrade> = Object.freeze({
  enabled: false,
  ...VIBRANT,
});

export const COLOR_GRADE_VIBRANT: Readonly<ColorGrade> = Object.freeze({
  enabled: true,
  ...VIBRANT,
});

const RANGES = {
  exposure: [0, 4],
  contrast: [0, 1],
  saturation: [-1, 1],
  highlights: [0, 1],
} as const;

/**
 * Complete grade from partial input. Missing or non-finite values take the
 * vibrant preset, others are clamped to their range; `enabled` defaults to
 * true when any input is given, so `{}` means "vibrant".
 */
export function resolveColorGrade(input?: Partial<ColorGrade>): ColorGrade {
  if (!input) {
    return { ...COLOR_GRADE_OFF };
  }
  const grade: ColorGrade = {
    ...COLOR_GRADE_VIBRANT,
    enabled: input.enabled ?? true,
  };
  for (const key of Object.keys(RANGES) as (keyof typeof RANGES)[]) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      const [min, max] = RANGES[key];
      grade[key] = Math.min(max, Math.max(min, value));
    }
  }
  return grade;
}

/** `u_grade` uniform: (exposure, contrast, saturation, highlights). */
export function colorGradeVec4(
  grade: ColorGrade,
): [number, number, number, number] {
  return [grade.exposure, grade.contrast, grade.saturation, grade.highlights];
}
