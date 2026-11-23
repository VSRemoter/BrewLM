/**
 * Notebook colors: a strip on the homepage card and, inside the notebook, the
 * accent (buttons, your chat bubbles, links' highlights). Each has a shade for
 * light themes and one for dark themes; index.css picks between them by the
 * data-scheme themes.ts puts on <html>.
 */
import type { CSSProperties } from "react";
import { contrast } from "./color";

export interface NotebookColor {
  id: string;
  name: string;
  light: string;
  dark: string;
}

export const NOTEBOOK_COLORS: NotebookColor[] = [
  { id: "orange", name: "Orange", light: "#ea580c", dark: "#fb923c" },
  { id: "red", name: "Red", light: "#dc2626", dark: "#f87171" },
  { id: "pink", name: "Pink", light: "#db2777", dark: "#f472b6" },
  { id: "violet", name: "Violet", light: "#7c3aed", dark: "#a78bfa" },
  { id: "blue", name: "Blue", light: "#2563eb", dark: "#60a5fa" },
  { id: "teal", name: "Teal", light: "#0f766e", dark: "#2dd4bf" },
  { id: "green", name: "Green", light: "#15803d", dark: "#4ade80" },
  { id: "amber", name: "Amber", light: "#b45309", dark: "#fbbf24" },
  { id: "slate", name: "Slate", light: "#475569", dark: "#94a3b8" },
];

export function isNotebookColor(id: string): boolean {
  return NOTEBOOK_COLORS.some((c) => c.id === id);
}

export function notebookColor(id: string | undefined): NotebookColor | undefined {
  return id ? NOTEBOOK_COLORS.find((c) => c.id === id) : undefined;
}

/** Black or white, whichever reads better on the color. */
const inkOn = (hex: string) => (contrast(hex, "#ffffff") >= contrast(hex, "#111111") ? "#ffffff" : "#111111");

/**
 * Variables for an element with the `nb-tint` class: --nb-accent (and
 * --nb-accent-ink) resolve to the shade for the theme on screen. Undefined
 * for a notebook without a color.
 */
export function notebookTintStyle(id: string | undefined): CSSProperties | undefined {
  const c = notebookColor(id);
  if (!c) return undefined;
  return {
    "--nb-light": c.light,
    "--nb-light-ink": inkOn(c.light),
    "--nb-dark": c.dark,
    "--nb-dark-ink": inkOn(c.dark),
  } as CSSProperties;
}
