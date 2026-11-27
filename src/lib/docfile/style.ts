/**
 * The look a request asks for, made safe to write into a file and a preview:
 * colors (hex, rgb() or common names) and two-color gradients, font names,
 * numbers kept in range, and text kept readable on its background. Every
 * value here ends up in XML attributes and inline CSS, so nothing is passed
 * through as typed: colors become RRGGBB, fonts plain words.
 */

/** A color as RRGGBB (no #). */
export type Hex = string;

/** A two-color gradient; `angle` in degrees, 0 = left to right, 90 = top to bottom. */
export interface Gradient {
  from: Hex;
  to: Hex;
  angle: number;
}

export type Fill = Hex | Gradient;

const NAMED: Record<string, Hex> = {
  black: "000000", white: "FFFFFF", red: "DC2626", darkred: "8B0000", crimson: "DC143C", maroon: "800000",
  green: "16A34A", darkgreen: "006400", forestgreen: "228B22", lime: "84CC16", olive: "808000", mint: "A7F3D0",
  blue: "2563EB", navy: "1E3A8A", darkblue: "00008B", royalblue: "4169E1", skyblue: "87CEEB", lightblue: "ADD8E6",
  teal: "0D9488", cyan: "06B6D4", turquoise: "40E0D0", purple: "7C3AED", violet: "8B5CF6", indigo: "4F46E5",
  lavender: "E6E6FA", pink: "EC4899", hotpink: "FF69B4", magenta: "D946EF", orange: "EA580C", coral: "FF7F50",
  salmon: "FA8072", gold: "D4AF37", yellow: "FACC15", brown: "92400E", tan: "D2B48C", beige: "F5F5DC",
  cream: "FFFDD0", ivory: "FFFFF0", gray: "6B7280", grey: "6B7280", lightgray: "E5E7EB", lightgrey: "E5E7EB",
  darkgray: "374151", darkgrey: "374151", silver: "C0C0C0", charcoal: "36454F", slate: "475569",
};

/** A color from "#C00", "#CC0000", "cc0000", "rgb(204,0,0)" or a common name; undefined when it isn't one. */
export function color(v: unknown): Hex | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (NAMED[t]) return NAMED[t];
  let m = /^#?([0-9a-f]{6})$/.exec(t);
  if (m) return m[1].toUpperCase();
  m = /^#?([0-9a-f]{3})$/.exec(t);
  if (m) return m[1].replace(/./g, (c) => c + c).toUpperCase();
  m = /^rgba?\((\d{1,3}),(\d{1,3}),(\d{1,3})/.exec(t);
  if (m) return [m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("").toUpperCase();
  return undefined;
}

/** A solid color or a gradient ({"from", "to", "angle"} or {"colors": [a, b]}). */
export function fillOf(v: unknown): Fill | undefined {
  const c = color(v);
  if (c) return c;
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const list = Array.isArray(o.colors) ? o.colors : [];
  const from = color(o.from ?? o.start ?? list[0]);
  const to = color(o.to ?? o.end ?? list[list.length - 1]);
  if (!from || !to) return from ?? to;
  return { from, to, angle: num(o.angle, 0, 360, 90) };
}

/** A number within [min, max], or `def` when it isn't one. */
export function num(v: unknown, min: number, max: number, def: number): number;
export function num(v: unknown, min: number, max: number): number | undefined;
export function num(v: unknown, min: number, max: number, def?: number): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

/** A font family name: letters, digits, spaces and hyphens only. */
export function font(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  // The first family of a CSS list ("Georgia, serif"), quotes and anything after a ; dropped.
  const t = v.split(/[;,]/)[0].replace(/["']/g, "").trim().replace(/\s+/g, " ");
  return /^[A-Za-z0-9][A-Za-z0-9 \-]{0,39}$/.test(t) ? t : undefined;
}

/** One of a fixed set of words. */
export function oneOf<T extends string>(v: unknown, options: readonly T[]): T | undefined {
  const t = typeof v === "string" ? v.trim().toLowerCase() : "";
  return options.find((o) => o.toLowerCase() === t);
}

export const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined);

/* -------------------------------- contrast -------------------------------- */

function luminance(hex: Hex): number {
  const ch = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function contrast(a: Hex, b: Hex): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** A fill's average color (what text sits on, for a gradient). */
export function solidOf(f: Fill): Hex {
  if (typeof f === "string") return f;
  return [0, 2, 4]
    .map((i) => Math.round((parseInt(f.from.slice(i, i + 2), 16) + parseInt(f.to.slice(i, i + 2), 16)) / 2).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/**
 * `text` when it reads on `bg` (contrast at least `min`), else dark or white,
 * whichever reads better. A gradient is judged at both ends.
 */
export function readable(text: Hex, bg: Fill, min = 3): Hex {
  const ends = typeof bg === "string" ? [bg] : [bg.from, bg.to];
  if (ends.every((e) => contrast(text, e) >= min)) return text;
  const dark = "111827";
  const light = "FFFFFF";
  const score = (c: Hex) => Math.min(...ends.map((e) => contrast(c, e)));
  return score(dark) >= score(light) ? dark : light;
}

/* ------------------------------- for the web ------------------------------ */

export const cssColor = (h: Hex) => `#${h}`;
/** CSS for a fill (our angle 0 = left to right is CSS's 90deg). */
export const cssFill = (f: Fill) => (typeof f === "string" ? `#${f}` : `linear-gradient(${(f.angle + 90) % 360}deg, #${f.from}, #${f.to})`);
/** A font stack for the preview: the named font, then sensible fallbacks. */
export const cssFont = (name: string | undefined, fallback = "Calibri, Carlito, 'Segoe UI', system-ui, sans-serif") =>
  name ? `'${name}', ${fallback}` : fallback;

/* ------------------------------ for the files ----------------------------- */

/** DrawingML fill (slides): a solid color or a linear gradient; `alpha` 0–1. */
export function drawingFill(f: Fill, alpha?: number): string {
  const a = alpha !== undefined && alpha < 1 ? `<a:alpha val="${Math.round(Math.max(0, alpha) * 100000)}"/>` : "";
  const clr = (h: Hex) => (a ? `<a:srgbClr val="${h}">${a}</a:srgbClr>` : `<a:srgbClr val="${h}"/>`);
  if (typeof f === "string") return `<a:solidFill>${clr(f)}</a:solidFill>`;
  return `<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0">${clr(f.from)}</a:gs><a:gs pos="100000">${clr(f.to)}</a:gs></a:gsLst><a:lin ang="${Math.round(f.angle * 60000) % 21600000}" scaled="0"/></a:gradFill>`;
}

/** `a` moved toward `b` by `t` (0–1). */
export function mix(a: Hex, b: Hex, t: number): Hex {
  return [0, 2, 4]
    .map((i) => {
      const x = parseInt(a.slice(i, i + 2), 16);
      const y = parseInt(b.slice(i, i + 2), 16);
      return Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
    })
    .join("")
    .toUpperCase();
}
