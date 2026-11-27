/**
 * Markdown → blocks, for writing Word files (docx.ts), slide text (pptx.ts)
 * and their previews (preview.ts). Covers what the document prompt offers:
 * headings, paragraphs, nested bullet and numbered lists, tables, quotes,
 * code blocks, rules and page breaks; inline bold, italic, code,
 * strikethrough and links; and a small HTML subset for the look — <span
 * style="color/background/font-size/font-family/…">, <u>, <mark>, <sup>,
 * <sub>, and <p|div|center align="…"> for alignment. Anything else stays
 * text, and every style value is checked (style.ts) before it's used.
 */
import { color, font, num, type Hex } from "./style";

export interface Inline {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  underline?: boolean;
  /** http(s) or mailto links only. */
  link?: string;
  color?: Hex;
  /** Background behind the text. */
  highlight?: Hex;
  /** Points. */
  size?: number;
  font?: string;
  script?: "super" | "sub";
}

export type Align = "left" | "center" | "right" | "justify";

export interface ListItem {
  /** Nesting depth, 0 = top level. */
  level: number;
  ordered: boolean;
  /** The number an ordered list starts at (its first item only). */
  start?: number;
  inlines: Inline[];
}

export type Block =
  | { type: "heading"; level: number; inlines: Inline[]; align?: Align }
  | { type: "paragraph"; inlines: Inline[]; align?: Align }
  | { type: "list"; items: ListItem[] }
  | { type: "code"; text: string }
  | { type: "quote"; paragraphs: Inline[][] }
  | { type: "table"; header: Inline[][]; rows: Inline[][][]; align: ("left" | "center" | "right")[] }
  | { type: "rule" }
  | { type: "pagebreak" };

type Style = Omit<Inline, "text">;

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

const TAGS = "span|font|u|ins|mark|sup|sub|b|strong|i|em|s|del|strike";

/** What one inline HTML tag does to the text inside it. */
function tagStyle(tag: string, attrs: string): Style {
  const t = tag.toLowerCase();
  if (t === "u" || t === "ins") return { underline: true };
  if (t === "mark") return { highlight: color(/background(?:-color)?\s*:\s*([^;"']+)/i.exec(attrs)?.[1]) ?? "FFF59D" };
  if (t === "sup") return { script: "super" };
  if (t === "sub") return { script: "sub" };
  if (t === "b" || t === "strong") return { bold: true };
  if (t === "i" || t === "em") return { italic: true };
  if (t === "s" || t === "del" || t === "strike") return { strike: true };
  const out: Style = {};
  const attr = (name: string) => new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  if (t === "font") {
    const c = attr("color");
    const f = attr("face");
    if (c) out.color = color(c[1] ?? c[2] ?? c[3]);
    if (f) out.font = font(f[1] ?? f[2] ?? f[3]);
  }
  const st = attr("style");
  const css = st ? (st[1] ?? st[2] ?? st[3] ?? "") : "";
  for (const decl of css.split(";")) {
    const [k, ...rest] = decl.split(":");
    const key = (k ?? "").trim().toLowerCase();
    const val = rest.join(":").trim();
    if (!val) continue;
    if (key === "color") out.color = color(val);
    else if (key === "background" || key === "background-color") out.highlight = color(val);
    else if (key === "font-family") out.font = font(val);
    else if (key === "font-size") {
      const n = parseFloat(val);
      if (Number.isFinite(n)) out.size = num(/px/i.test(val) ? n * 0.75 : /em|rem/i.test(val) ? n * 11 : n, 6, 96);
    } else if (key === "font-weight") out.bold = /bold|[6-9]00/i.test(val) || undefined;
    else if (key === "font-style") out.italic = /italic/i.test(val) || undefined;
    else if (key === "text-decoration") {
      if (/underline/i.test(val)) out.underline = true;
      if (/line-through/i.test(val)) out.strike = true;
    }
  }
  for (const k of Object.keys(out) as (keyof Style)[]) if (out[k] === undefined) delete out[k];
  return out;
}

/** Where a tag opened at `from` closes (nested same-name tags counted); -1 if it doesn't. */
function closingTag(s: string, tag: string, from: number): { start: number; end: number } {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = from;
  let depth = 1;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return { start: m.index, end: m.index + m[0].length };
  }
  return { start: -1, end: -1 };
}

/** Inline markdown → styled runs. `<br>` becomes a newline. */
export function parseInline(src: string, base: Style = {}): Inline[] {
  const s = src.replace(/<br\s*\/?>/gi, "\n");
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ ...base, text: buf });
    buf = "";
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length && /[\\`*_~[\]()#+\-.!|>{}]/.test(s[i + 1])) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ ...base, text: s.slice(i + 1, end), code: true });
        i = end + 1;
        continue;
      }
    }
    const two = s.slice(i, i + 2);
    if ((two === "**" || two === "__" || two === "~~") && s[i + 2] && !/\s/.test(s[i + 2])) {
      const end = s.indexOf(two, i + 2);
      if (end > i + 2) {
        flush();
        const style = two === "~~" ? { strike: true } : { bold: true };
        out.push(...parseInline(s.slice(i + 2, end), { ...base, ...style }));
        i = end + 2;
        continue;
      }
    }
    if ((c === "*" || c === "_") && s[i + 1] && !/\s/.test(s[i + 1]) && !(c === "_" && /\w/.test(s[i - 1] ?? ""))) {
      let end = i + 1;
      // The closing mark: not doubled, not after a space, and for _ not inside a word.
      for (;;) {
        end = s.indexOf(c, end);
        if (end < 0) break;
        const ok = s[end + 1] !== c && !/\s/.test(s[end - 1]) && !(c === "_" && /\w/.test(s[end + 1] ?? ""));
        if (ok) break;
        end += s[end + 1] === c ? 2 : 1;
      }
      if (end > i + 1) {
        flush();
        out.push(...parseInline(s.slice(i + 1, end), { ...base, italic: true }));
        i = end + 1;
        continue;
      }
    }
    if (c === "<") {
      const open = new RegExp(`^<(${TAGS})(\\s[^>]*)?>`, "i").exec(s.slice(i));
      if (open) {
        const close = closingTag(s, open[1], i + open[0].length);
        if (close.start >= 0) {
          flush();
          out.push(...parseInline(s.slice(i + open[0].length, close.start), { ...base, ...tagStyle(open[1], open[2] ?? "") }));
          i = close.end;
          continue;
        }
      }
      // A stray closing tag, or one that never closes: dropped, not shown.
      const stray = new RegExp(`^</?(${TAGS})(\\s[^>]*)?>`, "i").exec(s.slice(i));
      if (stray) {
        i += stray[0].length;
        continue;
      }
    }
    if (c === "!" && s[i + 1] === "[") {
      // An image: keep its alt text (files are made without pictures).
      const m = /^!\[([^\]]*)\]\([^)]*\)/.exec(s.slice(i));
      if (m) {
        buf += m[1];
        i += m[0].length;
        continue;
      }
    }
    if (c === "[") {
      const m = /^\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(s.slice(i));
      if (m) {
        flush();
        const link = SAFE_LINK.test(m[2]) ? m[2] : undefined;
        out.push(...parseInline(m[1], link ? { ...base, link } : base));
        i += m[0].length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return merge(out);
}

/** Join neighbouring runs with the same style. */
function merge(runs: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const r of runs) {
    const prev = out[out.length - 1];
    if (prev && sameStyle(prev, r)) prev.text += r.text;
    else out.push({ ...r });
  }
  return out;
}

const STYLE_KEYS = ["bold", "italic", "code", "strike", "underline", "link", "color", "highlight", "size", "font", "script"] as const;
const sameStyle = (a: Inline, b: Inline) => STYLE_KEYS.every((k) => (a[k] ?? false) === (b[k] ?? false));

/** The plain text of some runs. */
export const plain = (runs: Inline[]) => runs.map((r) => r.text).join("");

/* --------------------------------- blocks --------------------------------- */

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST = /^(\s*)([-*+•]|\d{1,9}[.)])\s+(.*)$/;
const FENCE = /^ {0,3}(```+|~~~+)/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const PAGE_BREAK = /^\s*(<!--\s*page\s*-?break\s*-->|\\pagebreak|\\newpage|<div[^>]*page-break-(?:after|before)\s*:\s*always[^>]*>\s*<\/div>|<br[^>]*page-break[^>]*>)\s*$/i;
/** <p align="center">…</p>, <center>…</center>, <div style="text-align:right">…</div>: one aligned block. */
const ALIGN_OPEN = /^\s*<(p|div|center)(\s[^>]*)?>/i;

function alignOf(tag: string, attrs: string): Align | undefined {
  if (tag.toLowerCase() === "center") return "center";
  const m = /(?:align\s*=\s*["']?|text-align\s*:\s*)(left|center|centre|right|justify)/i.exec(attrs);
  if (!m) return undefined;
  const a = m[1].toLowerCase();
  return a === "centre" ? "center" : (a as Align);
}

/** One table row's cells, split on pipes that aren't escaped or inside code. */
function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let code = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "\\" && t[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "`") {
      code = !code;
      cur += c;
    } else if (c === "|" && !code) {
      cells.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

const tabsToSpaces = (s: string) => s.replace(/\t/g, "    ");

export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  const startsBlock = (line: string, next?: string) =>
    HEADING.test(line) ||
    PAGE_BREAK.test(line) ||
    ALIGN_OPEN.test(line) ||
    LIST.test(line) ||
    FENCE.test(line) ||
    RULE.test(line) ||
    /^\s*>/.test(line) ||
    (line.includes("|") && next !== undefined && TABLE_SEP.test(next));

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    if (PAGE_BREAK.test(line)) {
      blocks.push({ type: "pagebreak" });
      i++;
      continue;
    }

    const aligned = ALIGN_OPEN.exec(line);
    if (aligned) {
      // Up to the closing tag (same line or a later one); each paragraph inside takes the alignment.
      const tag = aligned[1];
      const align = alignOf(tag, aligned[2] ?? "");
      const body: string[] = [];
      let rest = line.slice(aligned[0].length);
      for (;;) {
        const end = new RegExp(`</${tag}\\s*>`, "i").exec(rest);
        if (end) {
          body.push(rest.slice(0, end.index));
          i++;
          break;
        }
        body.push(rest);
        i++;
        if (i >= lines.length) break;
        rest = lines[i];
      }
      for (const b of parseBlocks(body.join("\n"))) {
        if ((b.type === "paragraph" || b.type === "heading") && align) b.align = align;
        blocks.push(b);
      }
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const close = fence[1][0].repeat(3);
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(close)) body.push(lines[i++]);
      i++; // the closing fence
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      blocks.push({ type: "heading", level: h[1].length, inlines: parseInline(h[2]) });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"
      ) as ("left" | "center" | "right")[];
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        const cells = splitRow(lines[i]);
        rows.push(header.map((_, c) => parseInline(cells[c] ?? "")));
        i++;
      }
      blocks.push({ type: "table", header: header.map((c) => parseInline(c)), rows, align: header.map((_, c) => align[c] ?? "left") });
      continue;
    }

    if (/^\s*>/.test(line)) {
      const paragraphs: Inline[][] = [];
      let cur: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        const text = lines[i].replace(/^\s*>\s?/, "");
        if (!text.trim()) {
          if (cur.length) paragraphs.push(parseInline(cur.join(" ")));
          cur = [];
        } else cur.push(text.trim());
        i++;
      }
      if (cur.length) paragraphs.push(parseInline(cur.join(" ")));
      if (paragraphs.length) blocks.push({ type: "quote", paragraphs });
      continue;
    }

    if (LIST.test(line)) {
      const items: ListItem[] = [];
      /** Indents of the open nesting levels, outermost first. */
      const indents: number[] = [];
      const ordinals: (number | undefined)[] = [];
      while (i < lines.length) {
        const raw = tabsToSpaces(lines[i]);
        const m = LIST.exec(raw);
        if (m) {
          const indent = m[1].length;
          while (indents.length && indent < indents[indents.length - 1]) indents.pop();
          if (!indents.length || indent > indents[indents.length - 1]) indents.push(indent);
          const level = Math.min(indents.length - 1, 8);
          const ordered = /\d/.test(m[2]);
          const n = ordered ? parseInt(m[2], 10) : undefined;
          // A new run of numbers at this level starts where its first item says.
          const fresh = ordinals[level] === undefined;
          ordinals.length = level + 1;
          ordinals[level] = ordered ? n : undefined;
          items.push({ level, ordered, start: ordered && fresh ? n : undefined, inlines: parseInline(m[3]) });
          i++;
          continue;
        }
        if (!raw.trim()) {
          // A blank line ends the list unless more items (or their text) follow.
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          if (j < lines.length && (LIST.test(tabsToSpaces(lines[j])) || /^\s{2,}\S/.test(tabsToSpaces(lines[j])))) {
            i = j;
            continue;
          }
          break;
        }
        if (/^\s+\S/.test(raw) && items.length && !startsBlock(raw.trim(), lines[i + 1])) {
          // An item's text carried onto an indented line.
          const last = items[items.length - 1];
          last.inlines = merge([...last.inlines, { text: " " }, ...parseInline(raw.trim())]);
          i++;
          continue;
        }
        break;
      }
      blocks.push({ type: "list", items });
      continue;
    }

    // A paragraph: lines until a blank one or the start of another block.
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) para.push(lines[i++].trim());
    blocks.push({ type: "paragraph", inlines: parseInline(para.join(" ")) });
  }
  return blocks;
}
