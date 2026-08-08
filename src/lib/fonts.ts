import { setSetting } from "./db";

/**
 * UI font choices — applied by setting a --font-ui override on the root
 * element (body reads var(--font-ui)). "System" maps back to --font-sans,
 * so theme flavors (Matrix's mono stack) still come through. Stacks are
 * system-installed families only: the app needs no webfont downloads.
 */
export interface FontDef {
  id: string;
  name: string;
  /** CSS font stack — used both for the override and the picker preview. */
  stack: string;
}

export const FONTS: FontDef[] = [
  { id: "system", name: "System", stack: "var(--font-sans)" },
  {
    id: "serif",
    name: "Serif",
    stack: 'ui-serif, "New York", Georgia, "Iowan Old Style", "Times New Roman", serif',
  },
  {
    id: "rounded",
    name: "Rounded",
    stack: 'ui-rounded, "SF Pro Rounded", "Trebuchet MS", Verdana, sans-serif',
  },
  { id: "mono", name: "Mono", stack: "var(--font-mono)" },
  {
    id: "avenir",
    name: "Avenir",
    stack: '"Avenir Next", Avenir, "Century Gothic", Futura, ui-sans-serif, sans-serif',
  },
  {
    id: "typewriter",
    name: "Typewriter",
    stack: '"American Typewriter", "Courier New", Courier, monospace',
  },
];

export const DEFAULT_FONT = "system";

/** Swaps the UI font instantly by pushing a --font-ui override onto :root. */
export function applyFont(id: string): void {
  const f = FONTS.find((x) => x.id === id) ?? FONTS[0];
  document.documentElement.style.setProperty("--font-ui", f.stack);
}

/** Applies the font *and* persists it to the settings table. */
export async function chooseFont(id: string): Promise<void> {
  applyFont(id);
  await setSetting("font", id);
}
