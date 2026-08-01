import { setSetting } from "./db";

export interface ThemeDef {
  id: string;
  name: string;
  blurb: string;
  /** Swatch colors for the picker preview (mirror of the CSS palette). */
  swatch: { canvas: string; panel: string; accent: string; ink: string };
}

export const THEMES: ThemeDef[] = [
  {
    id: "original",
    name: "Original",
    blurb: "Clean light neutral",
    swatch: { canvas: "#fafafa", panel: "#ffffff", accent: "#171717", ink: "#171717" },
  },
  {
    id: "midnight",
    name: "Midnight",
    blurb: "True dark mode",
    swatch: { canvas: "#0e0e11", panel: "#17171b", accent: "#f4f4f5", ink: "#f4f4f5" },
  },
  {
    id: "forest",
    name: "Forest",
    blurb: "Elegant dark green",
    swatch: { canvas: "#0c1410", panel: "#121f18", accent: "#3ecf8e", ink: "#e8f2ea" },
  },
  {
    id: "ocean",
    name: "Ocean",
    blurb: "Deep navy blue",
    swatch: { canvas: "#081120", panel: "#0f1c31", accent: "#4da2ff", ink: "#e7effc" },
  },
  {
    id: "copper",
    name: "Copper",
    blurb: "Warm roasted orange",
    swatch: { canvas: "#170e08", panel: "#221509", accent: "#e8853d", ink: "#f6ebdf" },
  },
  {
    id: "wine",
    name: "Wine",
    blurb: "Elegant burgundy red",
    swatch: { canvas: "#140a10", panel: "#1f1119", accent: "#d85674", ink: "#f7e9f0" },
  },
  {
    id: "rose",
    name: "Rose",
    blurb: "Soft cute pink",
    swatch: { canvas: "#fdf1f6", panel: "#ffffff", accent: "#ec4899", ink: "#3f1a2d" },
  },
  {
    id: "matrix",
    name: "Matrix",
    blurb: "Phosphor green hacker",
    swatch: { canvas: "#010603", panel: "#04140b", accent: "#22e05c", ink: "#a3f7bf" },
  },
];

export const DEFAULT_THEME = "original";

/** Swaps palettes instantly by flipping the root data-theme attribute. */
export function applyTheme(id: string): void {
  document.documentElement.dataset.theme = id;
}

/** Applies the theme *and* persists it to the settings table. */
export async function chooseTheme(id: string): Promise<void> {
  applyTheme(id);
  await setSetting("theme", id);
}
