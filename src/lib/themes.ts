import { setSetting } from "./db";
import { currentCustomColors, customSwatch, DEFAULT_CUSTOM_BG, DEFAULT_CUSTOM_TEXT } from "./customTheme";

export interface ThemeDef {
  id: string;
  name: string;
  blurb: string;
  /** Swatch colors for the picker preview (mirror of the CSS palette). */
  swatch: { canvas: string; panel: string; accent: string; ink: string };
}

/**
 * Coffee-named, in picker order (4 per row): light roasts, dark roasts, then
 * Custom Blend. Ids are the original names so saved choices keep resolving.
 */
export const THEMES: ThemeDef[] = [
  {
    id: "brew",
    name: "Brew",
    blurb: "The house roast: orange on white",
    swatch: { canvas: "#fff8f3", panel: "#ffffff", accent: "#f2541b", ink: "#2b1709" },
  },
  {
    id: "original",
    name: "Cream",
    blurb: "Clean and light, like fresh cream",
    swatch: { canvas: "#fafafa", panel: "#ffffff", accent: "#171717", ink: "#171717" },
  },
  {
    id: "rose",
    name: "Rose Latte",
    blurb: "Soft pink, lightly sweet",
    swatch: { canvas: "#fdf1f6", panel: "#ffffff", accent: "#ec4899", ink: "#3f1a2d" },
  },
  {
    id: "lilac",
    name: "Lavender Latte",
    blurb: "Soft violet with a floral finish",
    swatch: { canvas: "#f5f3fc", panel: "#ffffff", accent: "#7c5cff", ink: "#2d2342" },
  },
  {
    id: "copper",
    name: "Espresso",
    blurb: "Espresso brown with copper crema",
    swatch: { canvas: "#14100d", panel: "#1c1713", accent: "#e8873f", ink: "#f5eee6" },
  },
  {
    id: "midnight",
    name: "Dark Roast",
    blurb: "True dark, nothing added",
    swatch: { canvas: "#0e0e11", panel: "#17171b", accent: "#f4f4f5", ink: "#f4f4f5" },
  },
  {
    id: "wine",
    name: "Coffee Cherry",
    blurb: "Ripe burgundy with a gold finish",
    swatch: { canvas: "#140f13", panel: "#1c161b", accent: "#e0607e", ink: "#f6eff3" },
  },
  {
    id: "forest",
    name: "Matcha",
    blurb: "Green tea with an amber glow",
    swatch: { canvas: "#0f1412", panel: "#161d1a", accent: "#4cc38a", ink: "#eef2ec" },
  },
  {
    id: "ocean",
    name: "Cold Brew",
    blurb: "Cool navy, served over ice",
    swatch: { canvas: "#0b111c", panel: "#121a28", accent: "#4ea6ff", ink: "#edf2f9" },
  },
  {
    // Colors come from the user's picks (customTheme.ts); this swatch is the default pair.
    id: "custom",
    name: "Custom Blend",
    blurb: "Your own background and text colors",
    swatch: customSwatch({ bg: DEFAULT_CUSTOM_BG, text: DEFAULT_CUSTOM_TEXT }),
  },
];

/** Saved ids of retired themes → the closest theme still offered. */
export const RETIRED_THEMES: Record<string, string> = {
  velvet: "custom",
  sunset: "wine",
  candy: "lilac",
};

export const DEFAULT_THEME = "brew";

/** True for themes with a dark canvas (decides light/dark for embedded tools like Excalidraw). */
export function isDarkTheme(id: string): boolean {
  const canvas = id === "custom" ? currentCustomColors().bg : (THEMES.find((t) => t.id === id) ?? THEMES[0]).swatch.canvas;
  const hex = canvas.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

let themeApplied = false;
let themeFadeTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Swaps palettes by flipping the root data-theme attribute. Later switches
 * blend the colours for a moment; the first one (at launch) is instant.
 */
export function applyTheme(id: string): void {
  const root = document.documentElement;
  if (themeApplied && root.dataset.theme !== id) {
    root.classList.add("theme-fade");
    clearTimeout(themeFadeTimer);
    themeFadeTimer = setTimeout(() => root.classList.remove("theme-fade"), 400);
  }
  themeApplied = true;
  root.dataset.theme = id;
  // Phones colour the status bar from this (web app); headers use the panel colour.
  const panel = id === "custom" ? customSwatch(currentCustomColors()).panel : THEMES.find((t) => t.id === id)?.swatch.panel;
  if (panel) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", panel);
}

/** Applies the theme *and* persists it to the settings table. */
export async function chooseTheme(id: string): Promise<void> {
  applyTheme(id);
  await setSetting("theme", id);
}
