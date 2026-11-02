import { contrast, hexToRgb, isDark, mix, normalizeHex, readable, rgbToHsv } from "./color";

/**
 * The Custom theme: the user picks a background and a text color (any of the
 * 16.7M each) and every other token is derived from that pair — surfaces and
 * borders are blends of the two, labels fade the text toward the background,
 * and anything that would drop below a readable contrast gets nudged until it
 * passes. Works for dark and light backgrounds alike.
 */

export const DEFAULT_CUSTOM_BG = "#0c0306";
export const DEFAULT_CUSTOM_TEXT = "#ff6b8f";

export interface CustomColors {
  bg: string;
  text: string;
}

const rgbTriplet = (hex: string) => hexToRgb(hex).join(" ");

/** Every Custom token for a pair (keys are CSS custom properties). */
export function customPalette({ bg, text }: CustomColors): Record<string, string> {
  const dark = isDark(bg);
  const panel = dark ? mix(bg, text, 0.04) : mix(bg, "#ffffff", 0.7);
  const tone = (t: number) => mix(panel, text, t);
  const hover = tone(dark ? 0.1 : 0.07);
  // Hover rows are the lowest-contrast place text sits, so check against them.
  const ink = readable(text, hover, 4.5);
  const accent = readable(text, panel, 3);
  // Button text: the background color when it reads well, else black or white.
  const accentInk =
    contrast(bg, accent) >= 4.5 ? bg : contrast("#000000", accent) >= contrast("#ffffff", accent) ? "#000000" : "#ffffff";
  const [hue, sat] = rgbToHsv(hexToRgb(text));
  // Colorful text → links in a brighter take on it; grey/white/black text → classic blue.
  const link = readable(
    sat >= 0.25 ? mix(text, dark ? "#ffffff" : "#000000", 0.15) : dark ? "#60a5fa" : "#2563eb",
    hover,
    4.5
  );
  // Next to a red accent, errors go coral/orange so they still stand out.
  const redAccent = sat >= 0.35 && (hue >= 330 || hue < 20);
  const preBg = dark ? mix(bg, "#000000", 0.5) : mix(ink, "#000000", 0.3);
  return {
    "color-scheme": dark ? "dark" : "light",
    "--color-canvas": bg,
    "--color-panel": panel,
    "--color-edge": tone(dark ? 0.22 : 0.16),
    "--color-edge-soft": tone(dark ? 0.12 : 0.09),
    "--color-ink": ink,
    "--color-ink-2": readable(mix(ink, panel, 0.25), hover, 4.5),
    "--color-ink-3": readable(mix(ink, panel, 0.4), hover, 4.5),
    "--color-accent": accent,
    "--color-accent-ink": accentInk,
    "--color-hover": hover,
    "--color-hover-soft": tone(dark ? 0.06 : 0.04),
    "--color-link": link,
    "--color-select": tone(0.25),
    "--color-scroll": tone(0.25),
    "--color-code-bg": tone(0.08),
    "--color-pre-bg": preBg,
    "--color-pre-ink": readable(mix(dark ? text : bg, "#ffffff", 0.6), preBg, 7),
    ...(dark
      ? {
          "--color-danger": redAccent ? "#ff9a6b" : "#f87171",
          "--color-danger-bg": "#2b1418",
          "--color-danger-edge": "#55262d",
          "--color-ok": "#4ade80",
          "--color-ok-bg": "#12241a",
          "--color-ok-edge": "#1e4d2f",
          "--color-warn": "#fcd34d",
          "--color-warn-bg": "#27200d",
          "--color-warn-edge": "#5a4a17",
        }
      : {
          "--color-danger": redAccent ? "#c2410c" : "#dc2626",
          "--color-danger-bg": "#fef2f2",
          "--color-danger-edge": "#f1b8b8",
          "--color-ok": "#15803d",
          "--color-ok-bg": "#f0fdf4",
          "--color-ok-edge": "#7ed9a0",
          "--color-warn": "#92400e",
          "--color-warn-bg": "#fffbeb",
          "--color-warn-edge": "#fcd34d",
        }),
    "--custom-glow": rgbTriplet(mix(bg, text, 0.3)),
    "--custom-dot": rgbTriplet(accent),
  };
}

/** Picker-preview colors for the Custom tile. */
export function customSwatch(colors: CustomColors) {
  const p = customPalette(colors);
  return { canvas: p["--color-canvas"], panel: p["--color-panel"], accent: p["--color-accent"], ink: p["--color-ink"] };
}

let current: CustomColors = { bg: DEFAULT_CUSTOM_BG, text: DEFAULT_CUSTOM_TEXT };

export function currentCustomColors(): CustomColors {
  return current;
}

/** Writes the Custom tokens, scoped to that theme so the others are untouched. */
export function applyCustomColors(colors: CustomColors): void {
  current = {
    bg: normalizeHex(colors.bg) ?? DEFAULT_CUSTOM_BG,
    text: normalizeHex(colors.text) ?? DEFAULT_CUSTOM_TEXT,
  };
  let style = document.getElementById("custom-theme") as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = "custom-theme";
    document.head.appendChild(style);
  }
  const decls = Object.entries(customPalette(current)).map(([k, v]) => `${k}:${v};`).join("");
  style.textContent = `:root[data-theme="custom"]{${decls}}`;
  if (document.documentElement.dataset.theme === "custom")
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", customSwatch(current).panel);
}
