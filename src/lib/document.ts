/**
 * Document: the Studio tool that writes a file — a Word document, PowerPoint
 * slides, an Excel spreadsheet or a Markdown file — from the user's request
 * and their sources.
 *
 * The model writes content, not files: markdown (with an optional style
 * block) for Word, plain markdown for Markdown, JSON slides with a theme for
 * PowerPoint, JSON sheets with styles for Excel. That content is what's saved
 * (artifact.data, as DocumentData JSON), synced, shared and revised; the file
 * itself is built from it whenever someone downloads it (docfile/), on the
 * desktop, in the web app and on a paired phone alike.
 *
 * The request is in charge: length, coverage, structure, wording and look
 * all follow it, and the prompts' own suggestions apply only where it says
 * nothing. Limits here are only there to keep a runaway reply from swamping
 * the app, far beyond anything a real file needs.
 */
import { evaluateBook, isFormula, showComputed, type Cell } from "./docfile/formula";
import { dateSerial, hasTime, numFormat, type NumFormat } from "./docfile/numfmt";
import { bool, color, fillOf, font, num, oneOf, type Fill, type Hex } from "./docfile/style";

export type { Cell } from "./docfile/formula";
export type { NumFormat } from "./docfile/numfmt";
export type { Fill, Hex } from "./docfile/style";

export type DocFormat = "docx" | "pptx" | "xlsx" | "md";
/** In the order the pickers show them. */
export const DOC_FORMATS: DocFormat[] = ["docx", "pptx", "xlsx", "md"];

export const DOC_FORMAT_INFO: Record<
  DocFormat,
  { label: string; long: string; noun: string; ext: string; mime: string; desc: string }
> = {
  docx: {
    label: "Word",
    long: "Word document",
    noun: "a Word document",
    ext: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    desc: "A formatted document with headings, lists and tables",
  },
  pptx: {
    label: "PowerPoint",
    long: "PowerPoint slides",
    noun: "a PowerPoint slide deck",
    ext: "pptx",
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    desc: "A slide deck with speaker notes",
  },
  xlsx: {
    label: "Excel",
    long: "Excel spreadsheet",
    noun: "an Excel spreadsheet",
    ext: "xlsx",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    desc: "Sheets with working formulas",
  },
  md: {
    label: "Markdown",
    long: "Markdown file",
    noun: "a Markdown file",
    ext: "md",
    mime: "text/markdown",
    desc: "Plain text with formatting marks, for notes apps and code",
  },
};

export const isDocFormat = (v: unknown): v is DocFormat => typeof v === "string" && (DOC_FORMATS as string[]).includes(v);

/** Words people use for each format ("slides", "excel", "word"…). */
export function docFormatFrom(word: string): DocFormat | null {
  const w = word.trim().toLowerCase().replace(/^\./, "");
  if (["docx", "doc", "word", "worddoc"].includes(w)) return "docx";
  if (["pptx", "ppt", "powerpoint", "slides", "slide", "deck", "presentation", "keynote"].includes(w)) return "pptx";
  if (["xlsx", "xls", "excel", "spreadsheet", "sheet", "sheets", "csv", "table"].includes(w)) return "xlsx";
  if (["md", "markdown", "text", "txt"].includes(w)) return "md";
  return null;
}

/* ------------------------------ slides: types ----------------------------- */

export interface DocBullet {
  text: string;
  sub?: string[];
}

export const SLIDE_LAYOUTS = ["title", "section", "bullets", "two-column", "table", "quote", "stat", "blank"] as const;
export type SlideLayout = (typeof SLIDE_LAYOUTS)[number];

export interface DocColumn {
  heading?: string;
  bullets: DocBullet[];
}

export type Align = "left" | "center" | "right";
export type VAlign = "top" | "middle" | "bottom";

export const SHAPES = ["rect", "roundRect", "ellipse", "triangle", "diamond", "star", "heart", "arrow", "chevron", "hexagon", "line"] as const;
export type ShapeKind = (typeof SHAPES)[number];

/** Something placed freely on a slide, in percent of the slide (x, y from the top-left). */
export interface SlideElement {
  type: "text" | "shape";
  x: number;
  y: number;
  w: number;
  h: number;
  shape?: ShapeKind;
  text?: string;
  /** Points. */
  size?: number;
  color?: Hex;
  font?: string;
  bold?: boolean;
  italic?: boolean;
  align?: Align;
  valign?: VAlign;
  fill?: Fill;
  /** 0–1. */
  opacity?: number;
  border?: Hex;
  /** Points. */
  borderWidth?: number;
  /** Degrees, clockwise. */
  rotate?: number;
}

/** The whole deck's look; anything missing is the clean default (deckLook). */
export interface DeckTheme {
  background?: Fill;
  text?: Hex;
  title?: Hex;
  accent?: Hex;
  accent2?: Hex;
  /** Title, section and quote slides. */
  coverBackground?: Fill;
  coverText?: Hex;
  headingFont?: string;
  bodyFont?: string;
  align?: "left" | "center";
  /** What marks a slide's title. */
  decoration?: "bar" | "underline" | "band" | "frame" | "none";
  /** 0.7–1.5: all text bigger or smaller. */
  textScale?: number;
}

export interface DocSlide {
  layout: SlideLayout;
  title: string;
  subtitle?: string;
  bullets?: DocBullet[];
  left?: DocColumn;
  right?: DocColumn;
  columns?: string[];
  rows?: string[][];
  quote?: string;
  attribution?: string;
  stats?: { value: string; label: string }[];
  /** What the speaker says (the file's speaker notes). */
  notes?: string;
  /* This slide's own look, over the theme. */
  background?: Fill;
  textColor?: Hex;
  titleColor?: Hex;
  accent?: Hex;
  align?: "left" | "center";
  /** Points, for the body text. */
  textSize?: number;
  /** Points. */
  titleSize?: number;
  elements?: SlideElement[];
}

/* ------------------------------ word: types ------------------------------- */

export interface DocStyle {
  font?: string;
  headingFont?: string;
  /** Body text, points. */
  size?: number;
  text?: Hex;
  /** Title and top-level headings. */
  heading?: Hex;
  /** Lower headings. */
  subheading?: Hex;
  accent?: Hex;
  link?: Hex;
  align?: "left" | "center" | "right" | "justify";
  titleAlign?: "left" | "center" | "right";
  /** 1–3. */
  lineSpacing?: number;
  pageColor?: Hex;
  paper?: "letter" | "a4";
  orientation?: "portrait" | "landscape";
  /** Inches. */
  margins?: number;
  tableHeader?: Hex;
  tableHeaderText?: Hex;
  tableStripe?: Hex;
  tableBorder?: Hex;
  /** Running header and footer text. */
  header?: string;
  footer?: string;
  pageNumbers?: boolean;
  /** The title (and a subtitle paragraph right after it) on a page of their own. */
  coverPage?: boolean;
}

/* ------------------------------ excel: types ------------------------------ */

export interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: Hex;
  fill?: Hex;
  /** Points. */
  size?: number;
  font?: string;
  align?: Align;
  valign?: VAlign;
  wrap?: boolean;
  /** Overrides the column's; null = General. */
  format?: NumFormat | null;
  border?: Hex;
}

export interface SheetStyle {
  font?: string;
  size?: number;
  headerFill?: Hex;
  headerText?: Hex;
  headerBold?: boolean;
  /** Fill for every other data row. */
  stripe?: Hex;
  /** Thin borders around every used cell, in this color. */
  border?: Hex;
  gridlines?: boolean;
  /** Keep the header row in view when scrolling. */
  freeze?: boolean;
  tabColor?: Hex;
}

export interface DocSheet {
  name: string;
  /** The header row (row 1); empty = no header row, and "rows" start at row 1. */
  columns: string[];
  /** Per column; null = General. */
  formats?: (NumFormat | null)[];
  /** Per column, in characters. */
  widths?: (number | null)[];
  align?: (Align | null)[];
  /** Data rows. Strings starting with "=" are formulas. */
  rows: Cell[][];
  /** Single cells by their A1 address in the sheet. */
  styles?: Record<string, CellStyle>;
  /** Merged ranges ("A1:D1"). */
  merge?: string[];
  style?: SheetStyle;
}

/* ---------------------------------- data ---------------------------------- */

/** What a document artifact stores (JSON in artifact.data). */
export interface DocumentData {
  format: DocFormat;
  /** What the user asked for. */
  prompt: string;
  /** Word and Markdown. */
  markdown?: string;
  /** Word: the look. */
  style?: DocStyle;
  /** PowerPoint. */
  theme?: DeckTheme;
  slides?: DocSlide[];
  /** Excel: the workbook's look (each sheet's "style" overrides it). */
  sheetStyle?: SheetStyle;
  sheets?: DocSheet[];
}

export const MAX_SLIDES = 200;
export const MAX_ELEMENTS = 80;
export const MAX_SHEETS = 50;
export const MAX_ROWS = 10_000;
export const MAX_COLS = 100;
/** Longest request kept, in characters. */
export const DOC_PROMPT_MAX = 8000;

const str = (v: unknown, max = 2000): string =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : typeof v === "number" && Number.isFinite(v) ? String(v) : "";

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Copy only the keys that have a value. */
function defined<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

/* --------------------------- slides: normalizing -------------------------- */

function bulletList(v: unknown, max = 40): DocBullet[] {
  if (typeof v === "string") return v.trim() ? [{ text: str(v) }] : [];
  if (!Array.isArray(v)) return [];
  const out: DocBullet[] = [];
  for (const b of v) {
    if (typeof b === "string" || typeof b === "number") {
      const text = str(b);
      if (text) out.push({ text });
    } else if (b && typeof b === "object") {
      const o = b as Record<string, unknown>;
      const text = str(o.text ?? o.title ?? o.point ?? o.heading);
      const subs = o.sub ?? o.subs ?? o.subpoints ?? o.children ?? o.bullets;
      const sub = Array.isArray(subs) ? subs.map((x) => str(x)).filter(Boolean).slice(0, 20) : [];
      if (text) out.push(sub.length ? { text, sub } : { text });
    }
    if (out.length >= max) break;
  }
  return out;
}

function column(v: unknown): DocColumn | undefined {
  if (Array.isArray(v) || typeof v === "string") {
    const bullets = bulletList(v);
    return bullets.length ? { bullets } : undefined;
  }
  const o = obj(v);
  if (!o) return undefined;
  const heading = str(o.heading ?? o.title ?? o.label, 200);
  const bullets = bulletList(o.bullets ?? o.points ?? o.items);
  if (!heading && !bullets.length) return undefined;
  return heading ? { heading, bullets } : { bullets };
}

const LAYOUT_ALIASES: Record<string, SlideLayout> = {
  title: "title",
  "title-slide": "title",
  cover: "title",
  section: "section",
  "section-header": "section",
  divider: "section",
  bullets: "bullets",
  bullet: "bullets",
  content: "bullets",
  list: "bullets",
  "title-and-content": "bullets",
  "two-column": "two-column",
  "two-columns": "two-column",
  columns: "two-column",
  comparison: "two-column",
  compare: "two-column",
  table: "table",
  quote: "quote",
  quotation: "quote",
  stat: "stat",
  stats: "stat",
  number: "stat",
  numbers: "stat",
  "big-number": "stat",
  kpi: "stat",
  blank: "blank",
  custom: "blank",
  freeform: "blank",
  canvas: "blank",
};

const SHAPE_ALIASES: Record<string, ShapeKind> = {
  rect: "rect", rectangle: "rect", square: "rect", box: "rect",
  roundrect: "roundRect", rounded: "roundRect", roundedrect: "roundRect", roundedrectangle: "roundRect", pill: "roundRect",
  ellipse: "ellipse", circle: "ellipse", oval: "ellipse", dot: "ellipse",
  triangle: "triangle", diamond: "diamond", rhombus: "diamond",
  star: "star", star5: "star", heart: "heart",
  arrow: "arrow", rightarrow: "arrow", chevron: "chevron", hexagon: "hexagon",
  line: "line", divider: "line", rule: "line",
};

const align = (v: unknown) => oneOf(v, ["left", "center", "right"] as const) ?? (/^centre$/i.test(String(v)) ? "center" : undefined);

function element(v: unknown): SlideElement | null {
  const o = obj(v);
  if (!o) return null;
  const shapeName = String(o.shape ?? (o.type !== "text" ? o.type : "") ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  const shape = SHAPE_ALIASES[shapeName];
  const text = typeof o.text === "string" ? o.text.trim().slice(0, 2000) : typeof o.text === "number" ? String(o.text) : "";
  if (!shape && !text) return null;
  const valign = oneOf(o.valign ?? o.verticalAlign, ["top", "middle", "bottom"] as const) ?? (/^center$/i.test(String(o.valign)) ? "middle" : undefined);
  return defined<SlideElement>({
    type: shape ? "shape" : "text",
    x: num(o.x ?? o.left, -50, 150, 0),
    y: num(o.y ?? o.top, -50, 150, 0),
    w: num(o.w ?? o.width, 0.2, 200, 20),
    h: num(o.h ?? o.height, 0.2, 200, shape === "line" ? 0.5 : 10),
    shape,
    text: text || undefined,
    size: num(o.size ?? o.fontSize, 6, 300),
    color: color(o.color ?? o.textColor),
    font: font(o.font ?? o.fontFamily),
    bold: bool(o.bold),
    italic: bool(o.italic),
    align: align(o.align),
    valign,
    fill: fillOf(o.fill ?? o.background),
    opacity: num(o.opacity, 0, 1),
    border: color(o.border ?? o.borderColor ?? o.outline),
    borderWidth: num(o.borderWidth ?? o.lineWidth, 0, 30),
    rotate: num(o.rotate ?? o.rotation, -360, 360),
  });
}

/** The deck's theme from the model's JSON: only values that make sense survive. */
export function normalizeTheme(v: unknown): DeckTheme | undefined {
  const o = obj(v);
  if (!o) return undefined;
  const t = defined<DeckTheme>({
    background: fillOf(o.background),
    text: color(o.text ?? o.textColor),
    title: color(o.title ?? o.titleColor),
    accent: color(o.accent),
    accent2: color(o.accent2 ?? o.secondary),
    coverBackground: fillOf(o.coverBackground ?? o.titleBackground),
    coverText: color(o.coverText ?? o.titleText),
    headingFont: font(o.headingFont ?? o.titleFont ?? o.font),
    bodyFont: font(o.bodyFont ?? o.font),
    align: oneOf(o.align, ["left", "center"] as const),
    decoration: oneOf(o.decoration, ["bar", "underline", "band", "frame", "none"] as const),
    textScale: num(o.textScale, 0.7, 1.5),
  });
  return Object.keys(t).length ? t : undefined;
}

/** A deck from the model's JSON, made safe: known layouts, values checked. Throws when there are no slides. */
export function normalizeDeck(x: unknown): { theme?: DeckTheme; slides: DocSlide[] } {
  const o = obj(x);
  const list = Array.isArray(x) ? x : o && Array.isArray(o.slides) ? (o.slides as unknown[]) : null;
  if (!list) throw new Error("The slides came back in an unexpected shape — try again.");
  const out: DocSlide[] = [];
  for (const raw of list) {
    const s = obj(raw);
    if (!s) continue;
    const title = str(s.title ?? s.heading, 300);
    const subtitle = str(s.subtitle ?? s.subheading, 600) || undefined;
    const notes = typeof s.notes === "string" ? s.notes.trim().slice(0, 10_000) || undefined : undefined;
    const bullets = bulletList(s.bullets ?? s.points ?? s.content ?? s.body);
    const left = column(s.left);
    const right = column(s.right);
    let cols = Array.isArray(s.columns) ? s.columns.map((c) => str(c, 200)).slice(0, 12) : [];
    let rows = Array.isArray(s.rows)
      ? (s.rows as unknown[]).filter(Array.isArray).map((r) => (r as unknown[]).map((c) => str(c, 500)).slice(0, 12))
      : [];
    if (!cols.length && rows.length > 1) [cols, ...rows] = rows;
    rows = rows.slice(0, 60).map((r) => cols.map((_, i) => r[i] ?? ""));
    const quote = str(s.quote ?? s.text, 1500) || undefined;
    const statsRaw = Array.isArray(s.stats) ? s.stats : Array.isArray(s.numbers) ? s.numbers : [];
    const stats = statsRaw
      .map((x) => obj(x))
      .filter((x): x is Record<string, unknown> => !!x)
      .map((x) => ({ value: str(x.value ?? x.number ?? x.stat, 40), label: str(x.label ?? x.text ?? x.caption, 200) }))
      .filter((x) => x.value)
      .slice(0, 6);
    const elements = Array.isArray(s.elements) ? s.elements.map(element).filter((e): e is SlideElement => !!e).slice(0, MAX_ELEMENTS) : [];
    let layout = LAYOUT_ALIASES[str(s.layout ?? s.type).toLowerCase().replace(/[_\s]+/g, "-")];
    // Missing, unknown or empty: go by what the slide carries.
    if (
      !layout ||
      (layout === "table" && !cols.length) ||
      (layout === "two-column" && !left && !right) ||
      (layout === "quote" && !s.quote && !quote) ||
      (layout === "stat" && !stats.length)
    ) {
      layout = cols.length && rows.length
        ? "table"
        : left || right
          ? "two-column"
          : stats.length
            ? "stat"
            : bullets.length
              ? "bullets"
              : typeof s.quote === "string"
                ? "quote"
                : elements.length
                  ? "blank"
                  : out.length === 0
                    ? "title"
                    : "section";
    }
    if (!title && !bullets.length && !left && !right && !rows.length && !quote && !stats.length && !elements.length) continue;
    const slide: DocSlide = { layout, title: title || (layout === "title" ? "Untitled" : "") };
    if (subtitle && layout !== "blank") slide.subtitle = subtitle;
    if (layout === "bullets") slide.bullets = bullets;
    if (layout === "two-column") {
      slide.left = left ?? { bullets: [] };
      slide.right = right ?? { bullets: [] };
    }
    if (layout === "table") {
      slide.columns = cols;
      slide.rows = rows;
    }
    if (layout === "quote") {
      slide.quote = quote ?? title;
      const by = str(s.attribution ?? s.author ?? s.by, 200);
      if (by) slide.attribution = by;
    }
    if (layout === "stat") slide.stats = stats;
    if (notes) slide.notes = notes;
    Object.assign(
      slide,
      defined({
        background: fillOf(s.background),
        textColor: color(s.textColor ?? s.color),
        titleColor: color(s.titleColor),
        accent: color(s.accent),
        align: oneOf(s.align, ["left", "center"] as const),
        textSize: num(s.textSize ?? s.fontSize, 8, 96),
        titleSize: num(s.titleSize, 12, 120),
      })
    );
    if (elements.length) slide.elements = elements;
    out.push(slide);
    if (out.length >= MAX_SLIDES) break;
  }
  if (!out.length) throw new Error("The deck came back without any slides — try again.");
  const theme = o ? normalizeTheme(o.theme ?? o.style) : undefined;
  return theme ? { theme, slides: out } : { slides: out };
}

/** Just the slides (older callers and tests). */
export const normalizeSlides = (x: unknown): DocSlide[] => normalizeDeck(x).slides;

/* ---------------------------- word: normalizing --------------------------- */

export function normalizeDocStyle(v: unknown): DocStyle | undefined {
  const o = obj(v);
  if (!o) return undefined;
  const s = defined<DocStyle>({
    font: font(o.font ?? o.bodyFont ?? o.fontFamily),
    headingFont: font(o.headingFont ?? o.titleFont),
    size: num(o.size ?? o.fontSize, 7, 32),
    text: color(o.text ?? o.textColor ?? o.color),
    heading: color(o.heading ?? o.headingColor ?? o.title ?? o.titleColor),
    subheading: color(o.subheading ?? o.subheadingColor ?? o.heading2),
    accent: color(o.accent),
    link: color(o.link ?? o.linkColor),
    align: oneOf(o.align ?? o.textAlign, ["left", "center", "right", "justify"] as const),
    titleAlign: oneOf(o.titleAlign, ["left", "center", "right"] as const),
    lineSpacing: num(o.lineSpacing ?? o.lineHeight, 0.8, 3),
    pageColor: color(o.pageColor ?? o.background ?? o.pageBackground),
    paper: oneOf(o.paper ?? o.pageSize, ["letter", "a4"] as const),
    orientation: oneOf(o.orientation, ["portrait", "landscape"] as const),
    margins: num(o.margins ?? o.margin, 0.25, 2.5),
    tableHeader: color(o.tableHeader ?? o.tableHeaderFill),
    tableHeaderText: color(o.tableHeaderText),
    tableStripe: color(o.tableStripe),
    tableBorder: color(o.tableBorder),
    header: str(o.header, 300) || undefined,
    footer: str(o.footer, 300) || undefined,
    pageNumbers: bool(o.pageNumbers),
    coverPage: bool(o.coverPage ?? o.titlePage),
  });
  return Object.keys(s).length ? s : undefined;
}

/** Markdown and its leading ```style block (Word's look), apart. */
export function splitStyleBlock(md: string): { style?: DocStyle; markdown: string } {
  const m = /^\s*```(?:style|json)?\s*\n(\{[\s\S]*?\})\s*\n```[ \t]*\n?/i.exec(md);
  if (!m) return { markdown: md };
  try {
    const style = normalizeDocStyle(JSON.parse(m[1]));
    return { style, markdown: md.slice(m[0].length).trim() };
  } catch {
    return { markdown: md };
  }
}

/* ---------------------------- excel: normalizing -------------------------- */

/** A sheet name Excel takes: no []:*?/\, at most 31 characters, unique. */
function sheetName(raw: string, taken: Set<string>, i: number): string {
  let name = raw.replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().replace(/^'+|'+$/g, "").slice(0, 31).trim();
  if (!name || name.toLowerCase() === "history") name = `Sheet${i + 1}`;
  let unique = name;
  for (let n = 2; taken.has(unique.toLowerCase()); n++) unique = `${name.slice(0, 31 - String(n).length - 1)} ${n}`;
  taken.add(unique.toLowerCase());
  return unique;
}

/** A cell's value; a {"v": …, "bold": true…} cell also hands back its style. */
function cellOf(v: unknown): { value: Cell; style?: CellStyle } {
  if (v === null || v === undefined) return { value: null };
  if (typeof v === "number") return { value: Number.isFinite(v) ? v : null };
  if (typeof v === "boolean") return { value: v };
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return { value: null };
    // Plain numbers typed as text become numbers; codes with leading zeros stay text.
    if (/^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(t)) return { value: Number(t) };
    return { value: t.slice(0, 5000) };
  }
  const o = obj(v);
  if (!o) return { value: null };
  const inner = cellOf(o.v ?? o.value ?? o.formula ?? o.f ?? null);
  return { value: inner.value, style: cellStyle(o) };
}

export function cellStyle(v: unknown): CellStyle | undefined {
  const o = obj(v);
  if (!o) return undefined;
  const s = defined<CellStyle>({
    bold: bool(o.bold),
    italic: bool(o.italic),
    underline: bool(o.underline),
    color: color(o.color ?? o.textColor),
    fill: color(o.fill ?? o.background ?? o.bg),
    size: num(o.size ?? o.fontSize, 6, 72),
    font: font(o.font ?? o.fontFamily),
    align: align(o.align),
    valign: oneOf(o.valign ?? o.verticalAlign, ["top", "middle", "bottom"] as const),
    wrap: bool(o.wrap),
    format: "format" in o ? numFormat(o.format) : undefined,
    border: color(o.border),
  });
  return Object.keys(s).length ? s : undefined;
}

export function sheetStyleOf(v: unknown): SheetStyle | undefined {
  const o = obj(v);
  if (!o) return undefined;
  const s = defined<SheetStyle>({
    font: font(o.font ?? o.fontFamily),
    size: num(o.size ?? o.fontSize, 6, 36),
    headerFill: color(o.headerFill ?? o.headerBackground),
    headerText: color(o.headerText ?? o.headerColor),
    headerBold: bool(o.headerBold),
    stripe: color(o.stripe ?? o.banding ?? o.stripeColor),
    border: color(o.border ?? o.borders),
    gridlines: bool(o.gridlines),
    freeze: bool(o.freeze ?? o.freezeHeader),
    tabColor: color(o.tabColor),
  });
  return Object.keys(s).length ? s : undefined;
}

/** "B3" → [row, col], 0-based. */
function a1(ref: string): [number, number] | null {
  const m = /^\$?([A-Z]{1,3})\$?(\d{1,7})$/i.exec(ref.trim());
  if (!m) return null;
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return [Number(m[2]) - 1, c - 1];
}

/** 0-based [row, col] → "B3". */
export function a1Name(r: number, c: number): string {
  let s = "";
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return `${s}${r + 1}`;
}

/** "A1:C2" (or "B4") → each cell's address; at most `max` of them. */
function expandRange(ref: string, max = 20_000): string[] {
  const [p, q] = ref.split(":");
  const a = a1(p);
  const b = q ? a1(q) : a;
  if (!a || !b) return [];
  const out: string[] = [];
  for (let r = Math.min(a[0], b[0]); r <= Math.max(a[0], b[0]); r++)
    for (let c = Math.min(a[1], b[1]); c <= Math.max(a[1], b[1]); c++) {
      out.push(a1Name(r, c));
      if (out.length >= max) return out;
    }
  return out;
}

/** Sheets from the model's JSON, made safe. Throws when there are none. */
export function normalizeWorkbook(x: unknown): { style?: SheetStyle; sheets: DocSheet[] } {
  const o = obj(x);
  const list = Array.isArray(x) ? x : o && Array.isArray(o.sheets) ? (o.sheets as unknown[]) : o && (o.columns || o.rows) ? [o] : null;
  if (!list) throw new Error("The spreadsheet came back in an unexpected shape — try again.");
  const taken = new Set<string>();
  const out: DocSheet[] = [];
  for (const [i, raw] of list.entries()) {
    const s = obj(raw);
    if (!s) continue;
    const headerSrc = (Array.isArray(s.columns) ? s.columns : Array.isArray(s.headers) ? s.headers : Array.isArray(s.header) ? s.header : null) as unknown[] | null;
    const rowsSrc = (Array.isArray(s.rows) ? s.rows : Array.isArray(s.data) ? s.data : []) as unknown[];
    let columns: string[] = [];
    let formats: (NumFormat | null)[] = [];
    const styles: Record<string, CellStyle> = {};
    if (headerSrc) {
      for (const c of headerSrc) {
        const co = obj(c);
        columns.push(co ? str(co.name ?? co.title ?? co.header, 200) : str(c, 200));
        formats.push(co && "format" in co ? numFormat(co.format) : null);
      }
    }
    // No "columns": no header row, and "rows" start at row 1.
    if (Array.isArray(s.formats)) formats = (s.formats as unknown[]).map((f) => numFormat(f));
    const offset = columns.length ? 1 : 0;
    // Rows as arrays, or as objects keyed by column name.
    const rows: Cell[][] = [];
    for (const [r, row] of rowsSrc.slice(0, MAX_ROWS).entries()) {
      const cells = Array.isArray(row) ? row.slice(0, MAX_COLS) : obj(row) && columns.length ? columns.map((c) => (row as Record<string, unknown>)[c]) : null;
      if (!cells) continue;
      rows.push(
        cells.map((v, c) => {
          const cell = cellOf(v);
          if (cell.style) styles[a1Name(r + offset, c)] = cell.style;
          return cell.value;
        })
      );
    }
    const width = Math.min(MAX_COLS, Math.max(columns.length, ...rows.map((r) => r.length), 0));
    if (width === 0) continue;
    if (columns.length) columns = Array.from({ length: width }, (_, c) => columns[c] ?? "");
    // Dates written as text ("2026-12-25") become real dates, shown in their column's date format or ISO.
    const fmts: (NumFormat | null)[] = Array.from({ length: width }, (_, c) => formats[c] ?? null);
    const grid = rows.map((r) => Array.from({ length: width }, (_, c) => r[c] ?? null));
    grid.forEach((r, ri) =>
      r.forEach((v, c) => {
        if (typeof v !== "string" || isFormula(v)) return;
        const serial = dateSerial(v);
        if (serial === null) return;
        r[c] = serial;
        const key = a1Name(ri + offset, c);
        const own = styles[key]?.format ?? fmts[c];
        if (own?.kind !== "date") styles[key] = { ...styles[key], format: { kind: "date", pattern: hasTime(v) ? "yyyy-mm-dd h:mm" : "yyyy-mm-dd" } };
      })
    );
    // Styles by cell or range ("A1", "A2:D2"); later entries win.
    const styleMap = obj(s.styles ?? s.cellStyles);
    if (styleMap)
      for (const [ref, st] of Object.entries(styleMap)) {
        const cs = cellStyle(st);
        if (cs) for (const key of expandRange(ref)) styles[key] = { ...styles[key], ...cs };
      }
    const sheet: DocSheet = { name: sheetName(str(s.name ?? s.title ?? s.sheet, 100), taken, i), columns, rows: grid };
    if (fmts.some(Boolean)) sheet.formats = fmts;
    const widths = Array.isArray(s.widths) ? (s.widths as unknown[]).slice(0, width).map((w) => num(w, 1, 255) ?? null) : [];
    if (widths.some((w) => w !== null)) sheet.widths = widths;
    const aligns = Array.isArray(s.align) ? (s.align as unknown[]).slice(0, width).map((a) => align(a) ?? null) : [];
    if (aligns.some(Boolean)) sheet.align = aligns;
    if (Object.keys(styles).length) sheet.styles = styles;
    const merge = Array.isArray(s.merge) ? (s.merge as unknown[]).map((m) => str(m, 20).toUpperCase()).filter((m) => /^[A-Z]{1,3}\d{1,7}:[A-Z]{1,3}\d{1,7}$/.test(m)).slice(0, 500) : [];
    if (merge.length) sheet.merge = merge;
    const own = sheetStyleOf({ ...(obj(s.style) ?? {}), ...(s.tabColor ? { tabColor: s.tabColor } : {}) });
    if (own) sheet.style = own;
    out.push(sheet);
    if (out.length >= MAX_SHEETS) break;
  }
  if (!out.length) throw new Error("The spreadsheet came back empty — try again.");
  const style = o ? sheetStyleOf(o.style ?? o.theme) : undefined;
  return style ? { style, sheets: out } : { sheets: out };
}

/** Just the sheets (older callers and tests). */
export const normalizeSheets = (x: unknown): DocSheet[] => normalizeWorkbook(x).sheets;

/** A sheet's cells as laid out in the file: its header row (if any) then its rows. */
export const sheetGrid = (sh: DocSheet): Cell[][] => (sh.columns.length ? [sh.columns, ...sh.rows] : sh.rows);

/** The number format a cell shows in (its own, else its column's; the header row has none). */
export function cellFormat(sh: DocSheet, r: number, c: number): NumFormat | null {
  if (sh.columns.length && r === 0) return null;
  const own = sh.styles?.[a1Name(r, c)];
  if (own && "format" in own) return own.format ?? null;
  return sh.formats?.[c] ?? null;
}

/* --------------------------------- replies -------------------------------- */

/** Markdown as the model sent it, without a code fence wrapped around the whole thing. */
export function cleanMarkdown(raw: string): string {
  let t = raw.trim();
  const fenced = /^```(?:markdown|md)?[^\n]*\n([\s\S]*?)\n```\s*$/i.exec(t);
  if (fenced && !/^```style/i.test(t)) t = fenced[1].trim();
  return t;
}

/** The first JSON object or array in a reply (models sometimes wrap it in prose or a fence). */
function jsonIn(raw: string): unknown {
  const t = raw.trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  try {
    return JSON.parse(t);
  } catch {
    /* look for it inside */
  }
  const start = t.search(/[[{]/);
  if (start < 0) throw new Error("The model didn't return the JSON it was asked for — try again.");
  const open = t[start];
  const close = open === "{" ? "}" : "]";
  const end = t.lastIndexOf(close);
  if (end <= start) throw new Error("The model's JSON was cut off — try again, or ask for less.");
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    throw new Error("The model's JSON didn't parse — try again.");
  }
}

/** A model's reply turned into the document's content. Throws a readable error when it's unusable. */
export function documentFromReply(format: DocFormat, prompt: string, raw: string): DocumentData {
  const base: DocumentData = { format, prompt: prompt.trim().slice(0, DOC_PROMPT_MAX) };
  if (format === "pptx") {
    const deck = normalizeDeck(jsonIn(raw));
    return defined({ ...base, theme: deck.theme, slides: deck.slides });
  }
  if (format === "xlsx") {
    const book = normalizeWorkbook(jsonIn(raw));
    return defined({ ...base, sheetStyle: book.style, sheets: book.sheets });
  }
  const cleaned = cleanMarkdown(raw);
  const { style, markdown } = format === "docx" ? splitStyleBlock(cleaned) : { style: undefined, markdown: cleaned };
  if (markdown.length < 30) throw new Error("The document came back empty — try again.");
  return defined({ ...base, markdown, style });
}

/** A stored document, or null when the data isn't one. */
export function parseDocument(data: string): DocumentData | null {
  try {
    const d = JSON.parse(data) as Partial<DocumentData>;
    if (!d || !isDocFormat(d.format)) return null;
    const prompt = typeof d.prompt === "string" ? d.prompt : "";
    if (d.format === "pptx") {
      const deck = normalizeDeck({ theme: d.theme, slides: d.slides });
      return defined({ format: "pptx" as const, prompt, theme: deck.theme, slides: deck.slides });
    }
    if (d.format === "xlsx") {
      const book = normalizeWorkbook({ style: d.sheetStyle, sheets: d.sheets });
      return defined({ format: "xlsx" as const, prompt, sheetStyle: book.style, sheets: book.sheets });
    }
    if (typeof d.markdown !== "string") return null;
    return defined({ format: d.format, prompt, markdown: d.markdown, style: d.format === "docx" ? normalizeDocStyle(d.style) : undefined });
  } catch {
    return null;
  }
}

/** Just the format, for icons in lists (no full parse). */
export function docFormatOf(data: string): DocFormat | null {
  const m = /"format"\s*:\s*"(docx|pptx|xlsx|md)"/.exec(data.slice(0, 200));
  if (m) return m[1] as DocFormat;
  try {
    const f = JSON.parse(data)?.format;
    return isDocFormat(f) ? f : null;
  } catch {
    return null;
  }
}

/* --------------------------------- prompts -------------------------------- */

/** Who the model is while writing a document (replaces the chat persona and rules). */
export const DOCUMENT_ROLE = {
  persona: "You write documents, slide decks and spreadsheets for the user, using the sources in their notebook where they help.",
  rules: [
    "- The user's request is in charge: follow it exactly on what the file covers, how long it is, how it's structured and worded, and how it looks. Suggestions in the format instructions apply only where the request says nothing.",
    "- Take facts, figures and examples from the user's sources where they're relevant. Where the request goes beyond them, use sound general knowledge — but never make up specifics (numbers, quotes, names, dates) and pass them off as coming from the sources.",
    "- Output only the file's content, in exactly the format asked for: no preface and no closing remarks.",
  ].join("\n"),
};

/** The system prompt when the notebook has no sources to draw on. */
export function noSourcesSystem(): string {
  return `${DOCUMENT_ROLE.persona}\n\n# Rules\n${DOCUMENT_ROLE.rules}\n\nThis notebook has no sources to draw on, so write from general knowledge.`;
}

const REQUEST_WINS =
  "The request wins on length, coverage, structure, wording and look; these are only defaults for what it leaves open.";

const FORMULA_FUNCTIONS =
  "SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, COUNTIF, SUMIF, AVERAGEIF, IF, IFERROR, AND, OR, NOT, ROUND, ROUNDUP, ROUNDDOWN, ABS, INT, MOD, SQRT, POWER, PRODUCT, MEDIAN, CONCATENATE, LEN, LEFT, RIGHT, UPPER, LOWER, TRIM and PMT, and the operators + - * / ^ & = <> < > <= >=";

const CONTRACT: Record<DocFormat, string> = {
  md: `Write it as a complete markdown document (GitHub-flavored), with the structure the request calls for — by default a single # title, then ## sections (### for subsections), with paragraphs, bullet or numbered lists, tables and **bold** where they help the reader. Math in LaTeX ($...$) is fine. ${REQUEST_WINS}
Output ONLY the markdown, with no preface and no code fence around it.`,

  docx: `Write it as a complete markdown document; it will be turned into a Word file.

To set its look, start with a style block holding one JSON object (every field optional; leave the block out for a clean default):
\`\`\`style
{"font": "Georgia", "headingFont": "Georgia", "size": 11, "text": "#1F2937", "heading": "#B91C1C", "subheading": "#15803D", "accent": "#B91C1C", "link": "#B91C1C",
 "align": "left", "titleAlign": "center", "lineSpacing": 1.15, "pageColor": "#FFFDF7", "paper": "letter", "orientation": "portrait", "margins": 1,
 "tableHeader": "#B91C1C", "tableHeaderText": "#FFFFFF", "tableStripe": "#FDF2F2", "tableBorder": "#E5E7EB",
 "header": "Running header text", "footer": "Footer text", "pageNumbers": true, "coverPage": false}
\`\`\`
Colors are hex. "align" is left, center, right or justify; "paper" is letter or a4; "orientation" portrait or landscape; "margins" in inches; "coverPage": true puts the title, and a subtitle paragraph right after it, on a page of their own.

Then the document: a # title, ## sections and ### subsections, paragraphs, bullet and numbered lists (nest them with two spaces), tables, > quotes, **bold**, *italic*, \`code\`, [links](https://…), --- for a horizontal line, and <!-- pagebreak --> to start a new page. For finer control you may also use <span style="color:#hex; background-color:#hex; font-size:14pt; font-family:Georgia">…</span>, <u>…</u>, <mark>…</mark>, <sup>…</sup>, <sub>…</sub>, and <p align="center">…</p> (or right, justify) around a paragraph. No other HTML, no images, no diagrams and no LaTeX: write math in plain text and Unicode (x², √, ≤).

Defaults, for whatever the request leaves open: a structure that suits the purpose, and a tasteful look that fits the topic and audience (or no style block). ${REQUEST_WINS}
Output ONLY the document (its style block first, if it has one), with no preface and no code fence around the whole thing.`,

  pptx: `Write the deck as one JSON object. Only "slides" is required; use whatever else the request calls for.
{"theme": {"background": "#FFFFFF", "text": "#334155", "title": "#1E293B", "accent": "#2563EB", "accent2": "#38BDF8",
           "coverBackground": "#1E293B", "coverText": "#FFFFFF", "headingFont": "Calibri", "bodyFont": "Calibri",
           "align": "left", "decoration": "bar", "textScale": 1},
 "slides": [
  {"layout": "title", "title": "Deck title", "subtitle": "One line on what it covers"},
  {"layout": "bullets", "title": "Slide title", "subtitle": "Optional line under the title", "bullets": ["A point", {"text": "A point with detail", "sub": ["A sub-point"]}], "notes": "What the speaker says on this slide."},
  {"layout": "two-column", "title": "…", "left": {"heading": "Option A", "bullets": ["…"]}, "right": {"heading": "Option B", "bullets": ["…"]}},
  {"layout": "table", "title": "…", "columns": ["Column", "Column"], "rows": [["Cell", "Cell"]]},
  {"layout": "quote", "quote": "…", "attribution": "Who said it"},
  {"layout": "stat", "title": "…", "stats": [{"value": "8 h", "label": "What the number means"}]},
  {"layout": "section", "title": "Section name", "subtitle": "Optional line"},
  {"layout": "blank", "elements": [ … ]}
 ]}
The look:
- Colors are hex. "background" and "coverBackground" may be a gradient: {"from": "#…", "to": "#…", "angle": 90}. The cover colors are for title, section and quote slides. "decoration" marks slide titles: "bar", "underline", "band" (a strip across the top), "frame" or "none". "textScale" (0.7–1.5) makes all text bigger or smaller. Fonts are any font names.
- Any slide can override the theme with "background", "textColor", "titleColor", "accent", "align" ("left" or "center"), "textSize" and "titleSize" (points).
- Any slide can add "elements", drawn on top and placed in percent of the slide (x and y from the top-left corner, w and h its size):
  {"type": "text", "x": 55, "y": 70, "w": 40, "h": 12, "text": "…", "size": 20, "color": "#…", "font": "…", "bold": true, "italic": false, "align": "center", "valign": "middle", "fill": "#…"}
  {"type": "shape", "shape": "rect", "x": 0, "y": 90, "w": 100, "h": 10, "fill": "#…", "opacity": 0.8, "border": "#…", "borderWidth": 2, "rotate": 0, "text": "optional, with the text options"}
  Shapes: rect, roundRect, ellipse, triangle, diamond, star, heart, arrow, chevron, hexagon, line. Use elements for decorations, callouts, simple diagrams, emoji and custom layouts ("blank" slides are made of elements only).
Defaults, for whatever the request leaves open: start with a "title" slide; about 8–14 slides ending with a summary or next steps; 3–6 short bullets a slide with the detail in "notes" (2–4 sentences of what to say); a tasteful theme that suits the topic and audience (or no "theme" for a clean default). ${REQUEST_WINS}
Strings hold plain text: **bold** and *italic* work; other markdown, HTML and LaTeX don't.
Return ONLY the JSON object.`,

  xlsx: `Write the spreadsheet as one JSON object. Only "sheets" and each sheet's "rows" are required; use whatever else the request calls for.
{"style": {"font": "Calibri", "size": 11, "headerFill": "#E8EDF5", "headerText": "#1E293B", "stripe": "#F8FAFC", "border": "#CBD5E1", "gridlines": true, "freeze": true},
 "sheets": [
  {"name": "Budget", "tabColor": "#16A34A",
   "columns": ["Item", "Quantity", "Unit cost", "Total"],
   "formats": ["text", "integer", {"prefix": "$", "decimals": 2}, {"prefix": "$", "decimals": 2}],
   "widths": [28, 10, 12, 12], "align": [null, "center", null, null],
   "rows": [["Tires", 4, 120, "=B2*C2"], ["Oil change", 1, 45, "=B3*C3"], ["Total", "", "", "=SUM(D2:D3)"]],
   "styles": {"A4:D4": {"bold": true, "fill": "#DCFCE7"}, "D4": {"color": "#B91C1C"}},
   "merge": []}
 ]}
Rules:
- "columns" is the header row (row 1), so the first of "rows" is row 2. Leave "columns" out to start "rows" at row 1 — for example to put a title in row 1, merged across ("merge": ["A1:D1"]) and styled big. Every row has one cell per column; use "" for an empty cell.
- Numbers are JSON numbers, with no currency symbols, units or thousands separators inside them: show those with "formats", one per column — "text", "integer", "number", "money", "percent" (0.25 shows as 25.0%), "date", a date pattern like "dd/mm/yyyy", "mmm d, yyyy" or "h:mm", or {"prefix": "€", "suffix": " km", "decimals": 1, "thousands": true, "percent": false}. Write dates as "2026-12-25" (or "2026-12-25 14:30").
- Formulas are strings starting with "=", in A1 style (another sheet's cell is 'Sheet name'!B2). Use them for totals and anything worked out from other cells, so the sheet stays live. Stick to ${FORMULA_FUNCTIONS}.
- "styles" styles cells or ranges: "bold", "italic", "underline", "color", "fill", "size", "font", "align" (left, center, right), "valign" (top, middle, bottom), "wrap", "border" (a color) and "format" (as above). A sheet's "style" overrides the workbook's. "widths" are in characters. Colors are hex.
- Defaults, for whatever the request leaves open: one sheet unless the content calls for more, a header row, and a clean, readable look. ${REQUEST_WINS} Sheet names are at most 31 characters.
Return ONLY the JSON object.`,
};

/** The request for one document: what the user asked for, then the format's contract. */
export function buildDocumentPrompt(format: DocFormat, title: string, instructions: string): string {
  return `Create ${DOC_FORMAT_INFO[format].noun} titled “${title.trim() || "Untitled"}”.

What it should cover and do — follow this exactly:
${instructions.trim().slice(0, DOC_PROMPT_MAX)}

${CONTRACT[format]}`;
}

/** The contract a revision must keep, so the result still parses. */
export function documentReviseFormat(format: DocFormat): string {
  if (format === "pptx")
    return `Return ONLY the revised deck as one JSON object in the same shape as before ({"theme": …, "slides": [...]}), keeping everything the instruction doesn't change.\n\n${CONTRACT.pptx}`;
  if (format === "xlsx")
    return `Return ONLY the revised spreadsheet as one JSON object in the same shape as before ({"style": …, "sheets": [...]}), keeping everything the instruction doesn't change.\n\n${CONTRACT.xlsx}`;
  return `Return ONLY the revised document, keeping everything the instruction doesn't change.\n\n${CONTRACT[format]}`;
}

/** A number format as the prompt describes them (for showing a sheet back to the model). */
function formatForModel(f: NumFormat | null | undefined): unknown {
  if (!f) return null;
  if (f.kind === "text") return "text";
  if (f.kind === "date") return f.pattern;
  const { prefix, suffix, decimals, thousands, percent } = f;
  return defined({ prefix: prefix || undefined, suffix: suffix || undefined, decimals, thousands: thousands ? undefined : false, percent: percent || undefined });
}

/** What a revision is shown of the current document: the same shape the model writes. */
export function documentReviseContent(d: DocumentData): string {
  if (d.format === "pptx") return JSON.stringify(defined({ theme: d.theme, slides: d.slides }));
  if (d.format === "xlsx") {
    const sheets = (d.sheets ?? []).map((sh) => {
      const offset = sh.columns.length ? 1 : 0;
      // Dates go back as text ("2026-12-25"), as the model wrote them.
      const rows = sh.rows.map((row, r) =>
        row.map((v, c) => {
          const f = cellFormat(sh, r + offset, c);
          return typeof v === "number" && f?.kind === "date" ? isoDate(v, f.pattern) : v;
        })
      );
      const styles = sh.styles
        ? Object.fromEntries(Object.entries(sh.styles).map(([k, st]) => [k, "format" in st ? { ...st, format: formatForModel(st.format) } : st]))
        : undefined;
      return defined({
        name: sh.name,
        columns: sh.columns.length ? sh.columns : undefined,
        formats: sh.formats?.map(formatForModel),
        widths: sh.widths,
        align: sh.align,
        rows,
        styles,
        merge: sh.merge,
        style: sh.style,
      });
    });
    return JSON.stringify(defined({ style: d.sheetStyle, sheets }));
  }
  return `${d.style ? `\`\`\`style\n${JSON.stringify(d.style)}\n\`\`\`\n\n` : ""}${d.markdown ?? ""}`;
}

/** An Excel date serial back to "2026-12-25" (with the time when its pattern shows one). */
function isoDate(serial: number, pattern: string): string {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86_400_000));
  const day = d.toISOString().slice(0, 10);
  return /h/.test(pattern) ? `${day} ${d.toISOString().slice(11, 16)}` : day;
}

/* --------------------------------- reading -------------------------------- */

const mdCell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function mdTable(head: string[], rows: string[][]): string {
  if (!head.length) return "";
  return [
    `| ${head.map(mdCell).join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${head.map((_, i) => mdCell(r[i] ?? "")).join(" | ")} |`),
  ].join("\n");
}

const bulletLines = (bullets: DocBullet[] = []) =>
  bullets.flatMap((b) => [`- ${b.text}`, ...(b.sub ?? []).map((s) => `  - ${s}`)]).join("\n");

/** Each sheet's cells as shown (formulas worked out, number formats applied), as laid out in the file. */
export function sheetDisplay(sheets: DocSheet[]): string[][][] {
  const value = evaluateBook(sheets.map((sh) => ({ name: sh.name, grid: sheetGrid(sh) })));
  return sheets.map((sh, s) =>
    sheetGrid(sh).map((row, r) =>
      row.map((cell, c) => {
        const fmt = cellFormat(sh, r, c);
        if (typeof cell === "string" && isFormula(cell)) return showComputed(value(s, r, c), fmt, cell);
        return showComputed(cell === null ? { kind: "blank" } : { kind: "value", value: cell }, fmt);
      })
    )
  );
}

/** The document as readable markdown: copy, Add to sources, @-mentions and Revise read this. */
export function documentText(d: DocumentData): string {
  if (d.format === "pptx") {
    return (d.slides ?? [])
      .map((s, i) => {
        const parts = [`## Slide ${i + 1}${s.title ? `: ${s.title}` : ""}`];
        if (s.subtitle) parts.push(s.subtitle);
        if (s.bullets?.length) parts.push(bulletLines(s.bullets));
        for (const col of [s.left, s.right]) {
          if (!col) continue;
          parts.push([col.heading && `**${col.heading}**`, bulletLines(col.bullets)].filter(Boolean).join("\n"));
        }
        if (s.columns?.length) parts.push(mdTable(s.columns, s.rows ?? []));
        if (s.quote) parts.push(`> ${s.quote}${s.attribution ? `\n> — ${s.attribution}` : ""}`);
        if (s.stats?.length) parts.push(s.stats.map((x) => `- **${x.value}** ${x.label}`).join("\n"));
        const texts = (s.elements ?? []).map((e) => e.text).filter(Boolean);
        if (texts.length) parts.push(texts.join("\n"));
        if (s.notes) parts.push(`> Speaker notes: ${s.notes.replace(/\n+/g, " ")}`);
        return parts.join("\n\n");
      })
      .join("\n\n");
  }
  if (d.format === "xlsx") {
    const shown = sheetDisplay(d.sheets ?? []);
    return (d.sheets ?? [])
      .map((sh, i) => {
        const [head, ...rows] = sh.columns.length ? shown[i] : [shown[i][0]?.map((_, c) => a1Name(0, c).replace(/\d+$/, "")) ?? [], ...shown[i]];
        const kept = rows.slice(0, 500);
        return `## ${sh.name}\n\n${mdTable(head, kept)}${rows.length > kept.length ? `\n\n(${rows.length - kept.length} more rows)` : ""}`;
      })
      .join("\n\n");
  }
  return d.markdown ?? "";
}

/** One line for the Studio list: "12 slides", "2 sheets · 48 rows", "1,240 words". */
export function documentSummary(d: DocumentData): string {
  if (d.format === "pptx") {
    const n = d.slides?.length ?? 0;
    return `${n} slide${n === 1 ? "" : "s"}`;
  }
  if (d.format === "xlsx") {
    const n = d.sheets?.length ?? 0;
    const rows = (d.sheets ?? []).reduce((k, s) => k + s.rows.length, 0);
    return `${n} sheet${n === 1 ? "" : "s"} · ${rows} row${rows === 1 ? "" : "s"}`;
  }
  const words = (d.markdown ?? "").replace(/<[^>]+>/g, " ").split(/\s+/).filter((w) => /\w/.test(w)).length;
  return `${words.toLocaleString("en-US")} word${words === 1 ? "" : "s"}`;
}

/* ---------------------------------- files --------------------------------- */

/** The file to save: bytes for Office formats, text for Markdown. */
export async function documentFile(
  d: DocumentData,
  title: string
): Promise<{ data: Uint8Array | string; ext: string; mime: string; filterName: string }> {
  const info = DOC_FORMAT_INFO[d.format];
  const filterName = info.long;
  if (d.format === "md") return { data: d.markdown ?? "", ext: info.ext, mime: info.mime, filterName };
  // The writers load on first use: most sessions never build a file.
  const { buildOfficeFile } = await import("./docfile");
  return { data: buildOfficeFile(d, title), ext: info.ext, mime: info.mime, filterName };
}
