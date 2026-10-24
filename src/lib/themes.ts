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
    id: "brew",
    name: "Brew",
    blurb: "Signature orange on white",
    swatch: { canvas: "#fff8f3", panel: "#ffffff", accent: "#f2541b", ink: "#2b1709" },
  },
  {
    // id kept as "original" so existing saved preferences still resolve.
    id: "original",
    name: "Daylight",
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
    blurb: "Pine green with amber light",
    swatch: { canvas: "#0f1412", panel: "#161d1a", accent: "#4cc38a", ink: "#eef2ec" },
  },
  {
    id: "ocean",
    name: "Ocean",
    blurb: "Deep navy with sea-glass teal",
    swatch: { canvas: "#0b111c", panel: "#121a28", accent: "#4ea6ff", ink: "#edf2f9" },
  },
  {
    id: "copper",
    name: "Copper",
    blurb: "Roasted copper with verdigris",
    swatch: { canvas: "#14100d", panel: "#1c1713", accent: "#e8873f", ink: "#f5eee6" },
  },
  {
    id: "wine",
    name: "Wine",
    blurb: "Burgundy with champagne gold",
    swatch: { canvas: "#140f13", panel: "#1c161b", accent: "#e0607e", ink: "#f6eff3" },
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
  {
    id: "lilac",
    name: "Lilac",
    blurb: "Soft violet daytime",
    swatch: { canvas: "#f5f3fc", panel: "#ffffff", accent: "#7c5cff", ink: "#2d2342" },
  },
  {
    id: "sunset",
    name: "Sunset",
    blurb: "Plum dusk, amber glow",
    swatch: { canvas: "#1f1016", panel: "#2a161d", accent: "#ff9e42", ink: "#f7e8dd" },
  },
  {
    id: "candy",
    name: "Candy",
    blurb: "Neon pink on indigo",
    swatch: { canvas: "#0d0a1f", panel: "#17122e", accent: "#ff6bcb", ink: "#efeaff" },
  },
];

export const DEFAULT_THEME = "brew";

/** True for themes with a dark canvas (decides light/dark for embedded tools like Excalidraw). */
export function isDarkTheme(id: string): boolean {
  const hex = (THEMES.find((t) => t.id === id) ?? THEMES[0]).swatch.canvas.replace("#", "");
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
  const panel = THEMES.find((t) => t.id === id)?.swatch.panel;
  if (panel) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", panel);
}

/** Applies the theme *and* persists it to the settings table. */
export async function chooseTheme(id: string): Promise<void> {
  applyTheme(id);
  await setSetting("theme", id);
}
