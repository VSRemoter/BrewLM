/**
 * Looks: BrewLM's look-and-feel beyond colors.
 *
 * A Look is a complete style in one pick: a theme (with Custom Blend's colors
 * when it uses that), the interface font, and the style details below (corner
 * shape, density, line spacing, reading width, reading and code fonts, chat
 * style, code block colors). Built-in Looks ship with the app; people save
 * their own and pass them around as short share codes.
 *
 * The style details and the personal extras (match system light/dark,
 * accessibility, custom CSS) live in one JSON setting, `look` (LookPrefs).
 * They take effect as data attributes and CSS variables on <html>, so nothing
 * re-renders: index.css does the rest.
 */
import { applyCustomColors, type CustomColors } from "./customTheme";
import { normalizeHex } from "./color";
import { applyFont, FONTS } from "./fonts";
import { applyTheme, isDarkTheme, THEMES } from "./themes";

export type Shape = "sharp" | "soft" | "round";
export type Density = "compact" | "cozy" | "roomy";
export type Leading = "tight" | "normal" | "airy";
export type ReadWidth = "narrow" | "medium" | "wide" | "full";
export type ChatStyle = "bubbles" | "tinted" | "transcript";
export type ChatSide = "right" | "left";
export type CodeTheme = "theme" | "dark" | "light" | "sepia";

/** The parts of a Look besides its theme and interface font. */
export interface LookStyle {
  shape: Shape;
  density: Density;
  leading: Leading;
  width: ReadWidth;
  /** Font id from fonts.ts for chat replies and reports; "" = the interface font. */
  readFont: string;
  /** Id from CODE_FONTS. */
  codeFont: string;
  chatStyle: ChatStyle;
  chatSide: ChatSide;
  codeTheme: CodeTheme;
}

/** Everything in the `look` setting. */
export interface LookPrefs extends LookStyle {
  /** The Look last picked ("" = none); shown as the base of a customized one. */
  lookId: string;
  /** Follow the system's light/dark appearance: `theme` in light, darkTheme in dark. */
  matchSystem: boolean;
  darkTheme: string;
  /** Accessibility: stronger text and borders. */
  contrast: boolean;
  /** Accessibility: a bold outline on whatever has keyboard focus. */
  focusRings: boolean;
  /** Accessibility: no animations, whatever the system says. */
  reduceMotion: boolean;
  /** Power users' own CSS, applied last (sanitized: nothing it says can load from the network). */
  customCss: string;
}

/** A complete style: built in, or saved by the user. */
export interface Look extends LookStyle {
  id: string;
  name: string;
  blurb?: string;
  theme: string;
  /** Custom Blend's colors, when theme is "custom". */
  custom?: Required<CustomColors>;
  /** Interface font id from fonts.ts. */
  font: string;
}

export const STYLE_KEYS = [
  "shape",
  "density",
  "leading",
  "width",
  "readFont",
  "codeFont",
  "chatStyle",
  "chatSide",
  "codeTheme",
] as const satisfies readonly (keyof LookStyle)[];

export const SHAPES: { id: Shape; name: string }[] = [
  { id: "sharp", name: "Sharp" },
  { id: "soft", name: "Soft" },
  { id: "round", name: "Round" },
];
export const DENSITIES: { id: Density; name: string }[] = [
  { id: "compact", name: "Compact" },
  { id: "cozy", name: "Comfortable" },
  { id: "roomy", name: "Roomy" },
];
export const LEADINGS: { id: Leading; name: string }[] = [
  { id: "tight", name: "Tight" },
  { id: "normal", name: "Normal" },
  { id: "airy", name: "Airy" },
];
export const WIDTHS: { id: ReadWidth; name: string }[] = [
  { id: "narrow", name: "Narrow" },
  { id: "medium", name: "Medium" },
  { id: "wide", name: "Wide" },
  { id: "full", name: "Full" },
];
export const CHAT_STYLES: { id: ChatStyle; name: string }[] = [
  { id: "bubbles", name: "Bubbles" },
  { id: "tinted", name: "Soft bubbles" },
  { id: "transcript", name: "Transcript" },
];
export const CHAT_SIDES: { id: ChatSide; name: string }[] = [
  { id: "right", name: "Right" },
  { id: "left", name: "Left" },
];
export const CODE_THEMES: { id: CodeTheme; name: string; bg: string; ink: string }[] = [
  { id: "theme", name: "Theme", bg: "", ink: "" },
  { id: "dark", name: "Dark", bg: "#16161b", ink: "#e6e6eb" },
  { id: "light", name: "Light", bg: "#f4f4f6", ink: "#1f1f24" },
  { id: "sepia", name: "Sepia", bg: "#f4ecd8", ink: "#4a3a28" },
];
/** Monospace stacks for code: system-installed families only, like fonts.ts. */
export const CODE_FONTS: { id: string; name: string; stack: string }[] = [
  { id: "default", name: "SF Mono", stack: "var(--font-mono)" },
  { id: "menlo", name: "Menlo", stack: "Menlo, Consolas, ui-monospace, monospace" },
  { id: "monaco", name: "Monaco", stack: 'Monaco, "Lucida Console", ui-monospace, monospace' },
  { id: "courier", name: "Courier", stack: '"Courier New", Courier, ui-monospace, monospace' },
];

/** The Feel slider: one stop sets corner shape, density, line spacing and reading width together. */
export const FEEL_STOPS: { name: string; shape: Shape; density: Density; leading: Leading; width: ReadWidth }[] = [
  { name: "Roomy", shape: "round", density: "roomy", leading: "airy", width: "narrow" },
  { name: "Cozy", shape: "round", density: "cozy", leading: "airy", width: "medium" },
  { name: "Balanced", shape: "soft", density: "cozy", leading: "normal", width: "medium" },
  { name: "Snug", shape: "soft", density: "compact", leading: "normal", width: "wide" },
  { name: "Compact", shape: "sharp", density: "compact", leading: "tight", width: "wide" },
];

/** The stop matching these details, or -1 when they're a mix of their own. */
export function feelIndex(s: Pick<LookStyle, "shape" | "density" | "leading" | "width">): number {
  return FEEL_STOPS.findIndex(
    (f) => f.shape === s.shape && f.density === s.density && f.leading === s.leading && f.width === s.width
  );
}

/** The stop sharing the most details with these, for the slider's knob when they're a mix. */
export function nearestFeel(s: Pick<LookStyle, "shape" | "density" | "leading" | "width">): number {
  let best = 2;
  let bestScore = -1;
  FEEL_STOPS.forEach((f, i) => {
    const score = (["shape", "density", "leading", "width"] as const).filter((k) => f[k] === s[k]).length;
    if (score > bestScore) [best, bestScore] = [i, score];
  });
  return best;
}

/** Today's BrewLM: what everyone had before Looks. */
export const DEFAULT_STYLE: LookStyle = {
  shape: "soft",
  density: "cozy",
  leading: "normal",
  width: "medium",
  readFont: "",
  codeFont: "default",
  chatStyle: "bubbles",
  chatSide: "right",
  codeTheme: "theme",
};

export const DEFAULT_LOOK_PREFS: LookPrefs = {
  ...DEFAULT_STYLE,
  lookId: "house",
  matchSystem: false,
  darkTheme: "copper",
  contrast: false,
  focusRings: false,
  reduceMotion: false,
  customCss: "",
};

export const BUILT_IN_LOOKS: Look[] = [
  {
    id: "house",
    name: "House Blend",
    blurb: "Classic BrewLM, just as it ships",
    theme: "brew",
    font: "system",
    ...DEFAULT_STYLE,
  },
  {
    id: "morning",
    name: "Morning Pour",
    blurb: "Light and airy, with a serif for reading",
    theme: "original",
    font: "avenir",
    ...DEFAULT_STYLE,
    shape: "round",
    density: "roomy",
    leading: "airy",
    width: "narrow",
    readFont: "serif",
    chatStyle: "tinted",
    codeTheme: "light",
  },
  {
    id: "espresso",
    name: "Espresso Bar",
    blurb: "Dark, tight and sharp-edged",
    theme: "copper",
    font: "avenir",
    ...DEFAULT_STYLE,
    shape: "sharp",
    density: "compact",
    width: "wide",
    codeFont: "menlo",
    codeTheme: "dark",
  },
  {
    id: "nightshift",
    name: "Night Shift",
    blurb: "True dark with a plain transcript",
    theme: "midnight",
    font: "system",
    ...DEFAULT_STYLE,
    density: "compact",
    leading: "tight",
    width: "wide",
    chatStyle: "transcript",
    chatSide: "left",
  },
  {
    id: "study",
    name: "Study Hall",
    blurb: "Matcha green, serif and sepia code",
    theme: "forest",
    font: "system",
    ...DEFAULT_STYLE,
    leading: "airy",
    width: "narrow",
    readFont: "serif",
    chatStyle: "transcript",
    chatSide: "left",
    codeTheme: "sepia",
  },
  {
    id: "typewriter",
    name: "Typewriter",
    blurb: "Cream paper and typed text",
    theme: "original",
    font: "system",
    ...DEFAULT_STYLE,
    shape: "sharp",
    leading: "airy",
    width: "narrow",
    readFont: "typewriter",
    codeFont: "courier",
    chatStyle: "transcript",
    chatSide: "left",
    codeTheme: "light",
  },
  {
    id: "lavender",
    name: "Lavender Notes",
    blurb: "Soft violet, rounded everything",
    theme: "lilac",
    font: "rounded",
    ...DEFAULT_STYLE,
    shape: "round",
    density: "roomy",
    readFont: "rounded",
    chatStyle: "tinted",
  },
  {
    id: "coldbrew",
    name: "Cold Brew Lab",
    blurb: "Navy, compact and full width",
    theme: "ocean",
    font: "system",
    ...DEFAULT_STYLE,
    shape: "sharp",
    density: "compact",
    leading: "tight",
    width: "full",
    codeFont: "monaco",
    codeTheme: "dark",
  },
];

/* ------------------------------ validation ------------------------------ */

const ids = <T extends string>(list: { id: T }[]) => list.map((x) => x.id) as string[];
function oneOf<T extends string>(raw: unknown, list: { id: T }[], fallback: T): T {
  return typeof raw === "string" && ids(list).includes(raw) ? (raw as T) : fallback;
}
const fontId = (raw: unknown, fallback: string) =>
  typeof raw === "string" && FONTS.some((f) => f.id === raw) ? raw : fallback;
const themeId = (raw: unknown, fallback: string) =>
  typeof raw === "string" && THEMES.some((t) => t.id === raw) ? raw : fallback;

/** A style read from anywhere (the settings table, a share code): unknown values fall back to the default. */
export function parseStyle(o: Record<string, unknown>): LookStyle {
  return {
    shape: oneOf(o.shape, SHAPES, DEFAULT_STYLE.shape),
    density: oneOf(o.density, DENSITIES, DEFAULT_STYLE.density),
    leading: oneOf(o.leading, LEADINGS, DEFAULT_STYLE.leading),
    width: oneOf(o.width, WIDTHS, DEFAULT_STYLE.width),
    readFont: o.readFont === "" ? "" : fontId(o.readFont, ""),
    codeFont: oneOf(o.codeFont, CODE_FONTS, DEFAULT_STYLE.codeFont),
    chatStyle: oneOf(o.chatStyle, CHAT_STYLES, DEFAULT_STYLE.chatStyle),
    chatSide: oneOf(o.chatSide, CHAT_SIDES, DEFAULT_STYLE.chatSide),
    codeTheme: oneOf(o.codeTheme, CODE_THEMES, DEFAULT_STYLE.codeTheme),
  };
}

function asObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/** The stored `look` setting ("" on a fresh install → defaults). */
export function parseLookPrefs(raw: unknown): LookPrefs {
  const o = asObject(raw);
  if (!o) return { ...DEFAULT_LOOK_PREFS };
  return {
    ...parseStyle(o),
    lookId: typeof o.lookId === "string" ? o.lookId.slice(0, 64) : DEFAULT_LOOK_PREFS.lookId,
    matchSystem: o.matchSystem === true,
    darkTheme: themeId(o.darkTheme, DEFAULT_LOOK_PREFS.darkTheme),
    contrast: o.contrast === true,
    focusRings: o.focusRings === true,
    reduceMotion: o.reduceMotion === true,
    customCss: typeof o.customCss === "string" ? o.customCss.slice(0, CSS_MAX) : "",
  };
}

const NAME_MAX = 40;

/** One saved or shared Look; null when it isn't one. */
export function parseLook(raw: unknown): Look | null {
  const o = asObject(raw);
  if (!o) return null;
  const name = typeof o.name === "string" ? o.name.trim().slice(0, NAME_MAX) : "";
  if (!name) return null;
  const theme = themeId(o.theme, "");
  if (!theme) return null;
  let custom: Required<CustomColors> | undefined;
  if (theme === "custom") {
    const c = asObject(o.custom);
    const bg = normalizeHex(String(c?.bg ?? ""));
    const text = normalizeHex(String(c?.text ?? ""));
    if (!bg || !text) return null;
    custom = { bg, text, accent: normalizeHex(String(c?.accent ?? "")) ?? "" };
  }
  const id = typeof o.id === "string" && /^[\w-]{1,64}$/.test(o.id) ? o.id : newLookId();
  return { id, name, theme, ...(custom ? { custom } : {}), font: fontId(o.font, "system"), ...parseStyle(o) };
}

export function parseMyLooks(raw: unknown): Look[] {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw || "[]");
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out: Look[] = [];
  for (const item of list.slice(0, 48)) {
    const l = parseLook(item);
    if (l && !out.some((x) => x.id === l.id)) out.push(l);
  }
  return out;
}

export function newLookId(): string {
  return `my-${Math.random().toString(36).slice(2, 10)}`;
}

/* ------------------------------ looks ↔ settings ------------------------------ */

/** The appearance parts of Settings this module reads and writes. */
export interface AppearanceSettings {
  theme: string;
  font: string;
  customBg: string;
  customText: string;
  customAccent: string;
  look: LookPrefs;
}

export function styleOf(p: LookStyle): LookStyle {
  const out = {} as Record<string, unknown>;
  for (const k of STYLE_KEYS) out[k] = p[k];
  return out as unknown as LookStyle;
}

/** Whether the app looks exactly like this Look right now. */
export function wearing(look: Look, s: AppearanceSettings): boolean {
  if (look.font !== s.font) return false;
  if (look.theme !== s.theme && !(s.look.matchSystem && look.theme === s.look.darkTheme)) return false;
  if (look.theme === "custom" && look.custom) {
    const c = look.custom;
    if (c.bg !== s.customBg || c.text !== s.customText || (c.accent || "") !== (s.customAccent || "")) return false;
  }
  return STYLE_KEYS.every((k) => look[k] === s.look[k]);
}

/** A snapshot of the current appearance as a Look to save. */
export function lookFromSettings(s: AppearanceSettings, name: string): Look {
  const theme = activeThemeFor(s);
  return {
    id: newLookId(),
    name: name.trim().slice(0, NAME_MAX) || "My Look",
    theme,
    ...(theme === "custom" ? { custom: { bg: s.customBg, text: s.customText, accent: s.customAccent } } : {}),
    font: s.font,
    ...styleOf(s.look),
  };
}

/**
 * The settings that put a Look on. With Match system on, its theme takes the
 * light or the dark slot, whichever it is; the other slot stays.
 */
export function settingsForLook(look: Look, s: AppearanceSettings): Partial<AppearanceSettings> {
  const out: Partial<AppearanceSettings> = { font: look.font };
  const look2: LookPrefs = { ...s.look, ...styleOf(look), lookId: look.id };
  if (look.custom) {
    out.customBg = look.custom.bg;
    out.customText = look.custom.text;
    out.customAccent = look.custom.accent;
  }
  if (s.look.matchSystem && isDarkFor(look.theme, look.custom)) look2.darkTheme = look.theme;
  else out.theme = look.theme;
  out.look = look2;
  return out;
}

function isDarkFor(theme: string, custom?: CustomColors): boolean {
  if (theme === "custom" && custom) {
    const hex = custom.bg.replace("#", "");
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return 0.299 * r + 0.587 * g + 0.114 * b < 128;
  }
  return isDarkTheme(theme);
}

/* ------------------------------ share codes ------------------------------ */

const CODE_PREFIX = "BREWLOOK1.";

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** A short code anyone can paste into Import a Look. Holds only the Look itself. */
export function encodeLook(look: Look): string {
  const { id: _id, blurb: _blurb, ...rest } = look;
  return CODE_PREFIX + toBase64Url(JSON.stringify(rest));
}

/** The Look in a pasted share code (whitespace and surrounding text tolerated), or null. */
export function decodeLook(code: string): Look | null {
  const m = code.match(/BREWLOOK1\.([A-Za-z0-9_-]+)/);
  if (!m) return null;
  try {
    const look = parseLook(JSON.parse(fromBase64Url(m[1])));
    return look ? { ...look, id: newLookId() } : null;
  } catch {
    return null;
  }
}

/* ------------------------------ custom CSS ------------------------------ */

export const CSS_MAX = 20000;

/**
 * Custom CSS with everything that could reach outside the app taken out:
 * url(), @import and the image functions that take a bare string as an
 * address. Comments and backslash escapes go first so nothing can be spelled
 * around the filters.
 */
export function sanitizeCss(css: string): string {
  return css
    .slice(0, CSS_MAX)
    .replace(/\/\*[\s\S]*?(\*\/|$)/g, "")
    .replace(/\\/g, "")
    .replace(/<\/?\s*style[^>]*>/gi, "")
    .replace(/@import\b[^;]*;?/gi, "")
    .replace(/@namespace\b[^;]*;?/gi, "")
    .replace(/\b(url|src|image-set|-webkit-image-set|image|cross-fade|-webkit-cross-fade|element|expression)\s*\(/gi, "blocked(");
}

/* ------------------------------ applying ------------------------------ */

const LEADING_VALUES: Record<Leading, string> = { tight: "1.45", normal: "1.625", airy: "1.85" };
const WIDTH_VALUES: Record<ReadWidth, string> = { narrow: "36rem", medium: "42rem", wide: "54rem", full: "100%" };

let lastMotion: boolean | null = null;

/** Puts the style details on <html> (data attributes + CSS variables); index.css does the rest. */
export function applyLookPrefs(p: LookPrefs): void {
  const root = document.documentElement;
  const d = root.dataset;
  d.shape = p.shape;
  d.density = p.density;
  d.chatStyle = p.chatStyle;
  d.chatSide = p.chatSide;
  d.code = p.codeTheme;
  const flag = (key: string, on: boolean, value: string) => {
    if (on) d[key] = value;
    else delete d[key];
  };
  flag("contrast", p.contrast, "high");
  flag("focus", p.focusRings, "strong");
  flag("motion", p.reduceMotion, "reduce");
  root.style.setProperty("--read-leading", LEADING_VALUES[p.leading]);
  root.style.setProperty("--read-width", WIDTH_VALUES[p.width]);
  const read = p.readFont ? FONTS.find((f) => f.id === p.readFont) : undefined;
  if (read) root.style.setProperty("--font-read", read.stack);
  else root.style.removeProperty("--font-read");
  root.style.setProperty("--font-code", (CODE_FONTS.find((f) => f.id === p.codeFont) ?? CODE_FONTS[0]).stack);
  const code = CODE_THEMES.find((c) => c.id === p.codeTheme);
  if (code?.bg) {
    root.style.setProperty("--code-theme-bg", code.bg);
    root.style.setProperty("--code-theme-ink", code.ink);
  } else {
    root.style.removeProperty("--code-theme-bg");
    root.style.removeProperty("--code-theme-ink");
  }
  applyCustomCss(p.customCss);
  if (lastMotion !== p.reduceMotion) {
    lastMotion = p.reduceMotion;
    window.dispatchEvent(new Event("brewlm:motion"));
  }
}

function applyCustomCss(css: string): void {
  const id = "brewlm-custom-css";
  let el = document.getElementById(id) as HTMLStyleElement | null;
  const clean = sanitizeCss(css).trim();
  if (!clean) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("style");
    el.id = id;
  }
  // Always last in <head>, after Custom Blend's palette, so it wins ties.
  document.head.appendChild(el);
  if (el.textContent !== clean) el.textContent = clean;
}

const DARK_QUERY = "(prefers-color-scheme: dark)";
const systemDark = () => window.matchMedia?.(DARK_QUERY).matches ?? false;

/** The theme on screen: the dark slot while Match system is on and the system is dark. */
export function activeThemeFor(s: Pick<AppearanceSettings, "theme" | "look">): string {
  return s.look.matchSystem && systemDark() ? s.look.darkTheme : s.theme;
}

let current: AppearanceSettings | null = null;
let listening = false;

/** Applies every appearance setting at once (launch, Settings, Sync, Looks). */
export function applyAppearance(s: AppearanceSettings): void {
  current = s;
  applyCustomColors({ bg: s.customBg, text: s.customText, accent: s.customAccent });
  applyTheme(activeThemeFor(s));
  applyFont(s.font);
  applyLookPrefs(s.look);
  if (!listening && window.matchMedia) {
    listening = true;
    window.matchMedia(DARK_QUERY).addEventListener("change", () => {
      if (current?.look.matchSystem) applyTheme(activeThemeFor(current));
    });
  }
}
