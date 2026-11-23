/**
 * Alternate app icons: the BrewLM mug on a tile recolored to match a roast.
 * Each variant is the shipped icon (src-tauri/icons/brewlm-icon.svg) with its
 * gradient colors swapped, drawn to a PNG here and handed to the platform:
 * the Dock icon on macOS (set_app_icon in lib.rs), the tab's icon on the web.
 * The bundle's own icon shows while the app is closed.
 */
import iconSvg from "../../src-tauri/icons/brewlm-icon.svg?raw";
import { platform } from "../platform";
import { setSetting } from "./db";

export interface IconVariant {
  id: string;
  name: string;
  /** Tile gradient, left to right. */
  base: [string, string, string];
  pink: string;
  amber: string;
  ember: string;
  shadow: string;
  mug: string;
}

/** The original icon's colors, in the order the variants replace them. */
const ORIGINAL: IconVariant = {
  id: "classic",
  name: "House",
  base: ["#FF4B1F", "#FF5E14", "#FF8A12"],
  pink: "#FF6F7A",
  amber: "#FF9E1B",
  ember: "#C8261A",
  shadow: "#8A1E05",
  mug: "#FFFFFF",
};

export const APP_ICONS: IconVariant[] = [
  ORIGINAL,
  {
    id: "espresso",
    name: "Espresso",
    base: ["#4A2A1A", "#6B3E26", "#A8683A"],
    pink: "#C98B5A",
    amber: "#E8873F",
    ember: "#24120A",
    shadow: "#1A0C05",
    mug: "#F6E7D4",
  },
  {
    id: "cream",
    name: "Cream",
    base: ["#EFE7DC", "#F7F1E8", "#FFFFFF"],
    pink: "#FFE1D2",
    amber: "#FFE6C2",
    ember: "#DCCDB8",
    shadow: "#7A5A3A",
    mug: "#F2541B",
  },
  {
    id: "midnight",
    name: "Dark Roast",
    base: ["#141418", "#1F1F25", "#2E2E37"],
    pink: "#3E3E4A",
    amber: "#2A2A33",
    ember: "#000000",
    shadow: "#000000",
    mug: "#FFFFFF",
  },
  {
    id: "matcha",
    name: "Matcha",
    base: ["#1F7A4C", "#2E9A5E", "#7CC46A"],
    pink: "#B5E07A",
    amber: "#5CCB86",
    ember: "#0F4A2C",
    shadow: "#0B3320",
    mug: "#FFFFFF",
  },
  {
    id: "coldbrew",
    name: "Cold Brew",
    base: ["#173FAF", "#2563EB", "#4EA6FF"],
    pink: "#8FD0FF",
    amber: "#4FB3FF",
    ember: "#0B2470",
    shadow: "#081A4F",
    mug: "#FFFFFF",
  },
  {
    id: "rose",
    name: "Rose Latte",
    base: ["#D9346E", "#EC4899", "#F58BB4"],
    pink: "#FFC1D9",
    amber: "#F472B6",
    ember: "#9D174D",
    shadow: "#6B0F35",
    mug: "#FFFFFF",
  },
  {
    id: "lavender",
    name: "Lavender",
    base: ["#5B3FE0", "#7C5CFF", "#A78BFA"],
    pink: "#D8C4FF",
    amber: "#9F7AEA",
    ember: "#3B22A8",
    shadow: "#28176E",
    mug: "#FFFFFF",
  },
  {
    id: "cherry",
    name: "Coffee Cherry",
    base: ["#8E1235", "#B91C4B", "#E0607E"],
    pink: "#F59AB0",
    amber: "#E0607E",
    ember: "#4E0A1D",
    shadow: "#3A0716",
    mug: "#FFE7A8",
  },
];

export const DEFAULT_APP_ICON = "classic";

export function parseAppIcon(raw: string): string {
  return APP_ICONS.some((v) => v.id === raw) ? raw : DEFAULT_APP_ICON;
}

/** The icon's SVG in a variant's colors. */
export function iconSvgFor(id: string): string {
  const v = APP_ICONS.find((x) => x.id === id) ?? ORIGINAL;
  if (v === ORIGINAL) return iconSvg;
  const swaps: [string, string][] = [
    [ORIGINAL.base[0], v.base[0]],
    [ORIGINAL.base[1], v.base[1]],
    [ORIGINAL.base[2], v.base[2]],
    [ORIGINAL.pink, v.pink],
    [ORIGINAL.amber, v.amber],
    [ORIGINAL.ember, v.ember],
    [ORIGINAL.shadow, v.shadow],
    [ORIGINAL.mug, v.mug],
  ];
  // One pass, so a color swapped in is never swapped again (Cream's tile is white, like the mug).
  const map = new Map(swaps.map(([from, to]) => [from.toUpperCase(), to]));
  return iconSvg.replace(/#[0-9a-f]{6}\b/gi, (hex) => map.get(hex.toUpperCase()) ?? hex);
}

/** A data URL for <img> previews. */
export function iconDataUrl(id: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(iconSvgFor(id))}`;
}

async function iconPng(id: string, size = 512): Promise<Uint8Array> {
  const img = new Image();
  img.decoding = "async";
  img.src = iconDataUrl(id);
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.drawImage(img, 0, 0, size, size);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  if (!blob) throw new Error("couldn't draw the icon");
  return new Uint8Array(await blob.arrayBuffer());
}

let shown = DEFAULT_APP_ICON;

/** Shows a variant now. At launch the default is already showing, so nothing is drawn for it. */
export async function applyAppIcon(id: string): Promise<void> {
  const safe = parseAppIcon(id);
  if (safe === shown) return;
  shown = safe;
  try {
    await platform.setAppIcon(await iconPng(safe));
  } catch (e) {
    console.warn("app icon:", e);
  }
}

export async function chooseAppIcon(id: string): Promise<void> {
  await applyAppIcon(id);
  await setSetting("appIcon", parseAppIcon(id));
}
