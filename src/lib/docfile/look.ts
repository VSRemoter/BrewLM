/**
 * The finished look of each kind of file: the request's choices over the
 * clean defaults, with text kept readable on whatever it sits on. The file
 * writers and the previews both read these, so what BrewLM shows is what
 * the file holds.
 */
import type { DeckTheme, DocSlide, DocStyle, SheetStyle } from "../document";
import { mix, readable, solidOf, type Fill, type Hex } from "./style";

/* --------------------------------- slides --------------------------------- */

export interface DeckLook {
  background: Fill;
  text: Hex;
  title: Hex;
  accent: Hex;
  accent2: Hex;
  coverBackground: Fill;
  coverText: Hex;
  headingFont: string;
  bodyFont: string;
  align: "left" | "center";
  decoration: "bar" | "underline" | "band" | "frame" | "none";
  textScale: number;
}

export const DEFAULT_DECK: DeckLook = {
  background: "FFFFFF",
  text: "334155",
  title: "1E293B",
  accent: "2563EB",
  accent2: "38BDF8",
  coverBackground: "1E293B",
  coverText: "FFFFFF",
  headingFont: "Calibri",
  bodyFont: "Calibri",
  align: "left",
  decoration: "bar",
  textScale: 1,
};

export function deckLook(t: DeckTheme = {}): DeckLook {
  const look = { ...DEFAULT_DECK, ...t } as DeckLook;
  // A theme that sets fonts once means both.
  if (t.headingFont && !t.bodyFont) look.bodyFont = t.headingFont;
  if (t.bodyFont && !t.headingFont) look.headingFont = t.bodyFont;
  return look;
}

/** Slides drawn on the cover colors. */
export const isCover = (s: DocSlide) => s.layout === "title" || s.layout === "section" || s.layout === "quote";

export interface SlideLook {
  bg: Fill;
  text: Hex;
  title: Hex;
  /** Sub-points, captions, slide numbers. */
  muted: Hex;
  /** Bullets, rules, column headings (readable on the background). */
  accent: Hex;
  /** The title's decoration on cover slides. */
  accent2: Hex;
  /** Decorations on content slides (bars, bands, frames): the color as asked, since nothing reads it. */
  rule: Hex;
  align: "left" | "center";
  headingFont: string;
  bodyFont: string;
  decoration: DeckLook["decoration"];
  scale: number;
}

export function slideLook(deck: DeckLook, s: DocSlide): SlideLook {
  const cover = isCover(s);
  const bg = s.background ?? (cover ? deck.coverBackground : deck.background);
  const text = readable(s.textColor ?? (cover ? deck.coverText : deck.text), bg, 3);
  const title = readable(s.titleColor ?? (cover ? deck.coverText : deck.title), bg, 3);
  return {
    bg,
    text,
    title,
    muted: readable(mix(text, solidOf(bg), 0.3), bg, 2.5),
    accent: readable(s.accent ?? deck.accent, bg, 2.2),
    accent2: s.accent ?? (cover ? deck.accent2 : deck.accent),
    rule: s.accent ?? deck.accent,
    align: s.align ?? deck.align,
    headingFont: deck.headingFont,
    bodyFont: deck.bodyFont,
    decoration: deck.decoration,
    scale: deck.textScale,
  };
}

/** Points for a run of bullets, from how much there is (then the theme's scale, or the slide's own size). */
export function bulletPoints(lines: number, chars: number, half: boolean): number {
  const c = chars * (half ? 2 : 1);
  if (lines <= 4 && c <= 280) return 24;
  if (lines <= 6 && c <= 440) return 20;
  if (lines <= 9 && c <= 640) return 18;
  if (lines <= 12 && c <= 900) return 16;
  if (lines <= 18) return 14;
  return 12;
}

/* ---------------------------------- word ---------------------------------- */

export interface DocLook {
  font: string;
  headingFont: string;
  /** Points. */
  size: number;
  text: Hex;
  title: Hex;
  heading: Hex;
  subheading: Hex;
  accent: Hex;
  link: Hex;
  align: "left" | "center" | "right" | "justify";
  titleAlign: "left" | "center" | "right";
  lineSpacing: number;
  /** Undefined = plain white paper. */
  pageColor?: Hex;
  paper?: "letter" | "a4";
  orientation: "portrait" | "landscape";
  /** Inches. */
  margins: number;
  tableHeader: Hex;
  tableHeaderText: Hex;
  tableStripe?: Hex;
  tableBorder: Hex;
  header?: string;
  footer?: string;
  pageNumbers: boolean;
  coverPage: boolean;
}

export function docLook(s: DocStyle = {}): DocLook {
  const page = s.pageColor ?? "FFFFFF";
  const fontName = s.font ?? "Calibri";
  const heading = readable(s.heading ?? "1E3A8A", page, 3);
  const tableHeader = s.tableHeader ?? "E8EDF5";
  return {
    font: fontName,
    headingFont: s.headingFont ?? (s.font ? fontName : "Calibri"),
    size: s.size ?? 11,
    text: readable(s.text ?? "1F2937", page, 4.5),
    title: readable(s.heading ?? "111827", page, 3),
    heading,
    subheading: readable(s.subheading ?? s.heading ?? "1E40AF", page, 3),
    accent: s.accent ?? s.heading ?? "2563EB",
    link: readable(s.link ?? s.accent ?? "2563EB", page, 3),
    align: s.align ?? "left",
    titleAlign: s.titleAlign ?? "left",
    lineSpacing: s.lineSpacing ?? 1.15,
    pageColor: s.pageColor,
    paper: s.paper,
    orientation: s.orientation ?? "portrait",
    margins: s.margins ?? 1,
    tableHeader,
    tableHeaderText: readable(s.tableHeaderText ?? (s.tableHeader ? "FFFFFF" : "1E293B"), tableHeader, 3),
    tableStripe: s.tableStripe,
    tableBorder: s.tableBorder ?? "C9D1DD",
    header: s.header,
    footer: s.footer,
    pageNumbers: s.pageNumbers ?? false,
    coverPage: s.coverPage ?? false,
  };
}

/* ---------------------------------- excel --------------------------------- */

export interface SheetLook {
  font: string;
  size: number;
  headerFill: Hex;
  headerText: Hex;
  headerBold: boolean;
  stripe?: Hex;
  border?: Hex;
  gridlines: boolean;
  freeze: boolean;
  tabColor?: Hex;
}

/** The workbook's look with a sheet's own over it. */
export function sheetLook(book: SheetStyle = {}, own: SheetStyle = {}): SheetLook {
  const s = { ...book, ...own };
  const headerFill = s.headerFill ?? "E8EDF5";
  return {
    font: s.font ?? "Calibri",
    size: s.size ?? 11,
    headerFill,
    headerText: readable(s.headerText ?? (s.headerFill ? "FFFFFF" : "1E293B"), headerFill, 3),
    headerBold: s.headerBold ?? true,
    stripe: s.stripe,
    border: s.border,
    gridlines: s.gridlines ?? true,
    freeze: s.freeze ?? true,
    tabColor: s.tabColor,
  };
}
