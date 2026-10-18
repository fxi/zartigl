import {
  COLOR_GRADE_VIBRANT,
  resolveColorGrade,
  type ColorGrade,
} from "../engine";

const KEYS = ["exposure", "contrast", "saturation", "highlights"] as const;

/**
 * Advanced color settings: a toggle button opens a panel with the particle
 * color grade switch and its sliders. Inputs are found inside the panel,
 * by name; edits report the full grade.
 */
export class GradePanel {
  private readonly enabled: HTMLInputElement;
  private readonly sliders: Record<(typeof KEYS)[number], HTMLInputElement>;

  constructor(
    private readonly toggle: HTMLButtonElement,
    private readonly panel: HTMLElement,
    onChange: (grade: ColorGrade) => void,
  ) {
    const input = (name: string) => {
      const el = panel.querySelector<HTMLInputElement>(`input[name="${name}"]`);
      if (!el) {
        throw new Error(`Missing grade input: ${name}`);
      }
      return el;
    };
    this.enabled = input("enabled");
    this.sliders = {
      exposure: input("exposure"),
      contrast: input("contrast"),
      saturation: input("saturation"),
      highlights: input("highlights"),
    };
    toggle.addEventListener("click", () => this.setOpen(panel.hidden));
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.setOpen(false);
        toggle.focus();
      }
    });
    panel.addEventListener("input", () => {
      this.syncDisabled();
      onChange(this.value);
    });
    panel.addEventListener("reset", (event) => {
      event.preventDefault();
      this.value = { ...COLOR_GRADE_VIBRANT, enabled: this.enabled.checked };
      onChange(this.value);
    });
  }

  get value(): ColorGrade {
    const grade: Partial<ColorGrade> = { enabled: this.enabled.checked };
    for (const key of KEYS) {
      grade[key] = Number(this.sliders[key].value);
    }
    return resolveColorGrade(grade);
  }

  set value(grade: ColorGrade) {
    this.enabled.checked = grade.enabled;
    for (const key of KEYS) {
      this.sliders[key].value = String(grade[key]);
    }
    this.syncDisabled();
  }

  /** Shown for particle layers only. */
  set available(available: boolean) {
    this.toggle.hidden = !available;
    if (!available) {
      this.setOpen(false);
    }
  }

  private setOpen(open: boolean): void {
    this.panel.hidden = !open;
    this.toggle.setAttribute("aria-expanded", String(open));
  }

  private syncDisabled(): void {
    for (const key of KEYS) {
      this.sliders[key].disabled = !this.enabled.checked;
    }
  }
}
