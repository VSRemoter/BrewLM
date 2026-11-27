/**
 * Previews of a document's file, as HTML: slides drawn in the deck's look,
 * a Word document on its page in its fonts and colors, a sheet as a grid
 * with its cell styles and merges. The desktop and web app show these in
 * the Studio panel; the paired phone gets them from /assets/docfile.js. They
 * read the same looks (look.ts) as the file writers, so the preview is the
 * file.
 *
 * Safe to put in a page: every piece of text is escaped, colors are checked
 * RRGGBB values and fonts plain names (style.ts), and links are http(s) or
 * mailto only (mdblocks.ts).
 */
import type { DeckTheme, DocSheet, DocSlide, DocStyle, SheetStyle, SlideElement } from "../document";
import { a1Name, cellFormat } from "../document";
import { bulletPoints, deckLook, docLook, sheetLook, slideLook, type DocLook, type SlideLook } from "./look";
import { parseBlocks, parseInline, type Inline, type ListItem } from "./mdblocks";
import { cssFill, cssFont, mix, readable, solidOf, type Fill, type Hex } from "./style";

const h = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/* --------------------------------- slides --------------------------------- */

/** Points on a 960-point-wide slide, in container units. */
const pt = (n: number) => `${((n * 100) / 960).toFixed(3)}cqw`;
/** Inches across the slide (13.333 in) or down it (7.5 in), in percent. */
const ix = (inches: number) => `${((inches / 13.3333) * 100).toFixed(3)}%`;
const iy = (inches: number) => `${((inches / 7.5) * 100).toFixed(3)}%`;

/** Inline runs as HTML: bold, italic, underline, strike, code, color. */
function runsHtml(inlines: Inline[]): string {
  return inlines
    .map((r) => {
      let t = h(r.text);
      const css: string[] = [];
      if (r.color) css.push(`color:#${r.color}`);
      if (r.highlight) css.push(`background:#${r.highlight}`);
      if (r.size) css.push(`font-size:${r.size}pt`);
      if (r.font) css.push(`font-family:${cssFont(r.font)}`);
      if (r.code) css.push("font-family:Consolas,Menlo,monospace");
      if (r.bold) t = `<b>${t}</b>`;
      if (r.italic) t = `<i>${t}</i>`;
      if (r.underline) t = `<u>${t}</u>`;
      if (r.strike) t = `<s>${t}</s>`;
      if (r.script) t = `<${r.script === "super" ? "sup" : "sub"}>${t}</${r.script === "super" ? "sup" : "sub"}>`;
      if (r.link) t = `<a href="${h(r.link)}" target="_blank" rel="noreferrer noopener">${t}</a>`;
      return css.length ? `<span style="${css.join(";")}">${t}</span>` : t;
    })
    .join("");
}

const inline = (text: string) => runsHtml(parseInline(text));

const box = (x: string, y: string, w: string, ht: string, extra = "") =>
  `position:absolute;left:${x};top:${y};width:${w};height:${ht};${extra}`;

function bulletsHtml(bullets: { text: string; sub?: string[] }[], size: number, look: SlideLook, center: boolean): string {
  const sub = Math.max(10, Math.round(size * 0.82));
  return bullets
    .map(
      (b, i) =>
        `<div style="display:flex;gap:${pt(size * 0.45)};margin-top:${i ? pt(size * 0.55) : "0"};${center ? "justify-content:center;" : ""}"><span style="color:#${look.accent}">•</span><span>${inline(b.text)}</span></div>` +
        (b.sub ?? [])
          .map(
            (x) =>
              `<div style="display:flex;gap:${pt(sub * 0.45)};margin-top:${pt(sub * 0.3)};margin-left:${center ? "0" : pt(size * 1.3)};font-size:${pt(sub)};color:#${look.muted};${center ? "justify-content:center;" : ""}"><span>–</span><span>${inline(x)}</span></div>`
          )
          .join("")
    )
    .join("");
}

const SHAPE_SVG: Record<string, string> = {
  triangle: '<polygon points="50,0 100,100 0,100"/>',
  diamond: '<polygon points="50,0 100,50 50,100 0,50"/>',
  star: '<polygon points="50,0 61,35 98,35 68,57 79,91 50,70 21,91 32,57 2,35 39,35"/>',
  heart: '<path d="M50 92 C20 70 2 52 2 30 C2 14 14 4 28 4 C38 4 46 10 50 18 C54 10 62 4 72 4 C86 4 98 14 98 30 C98 52 80 70 50 92 Z"/>',
  arrow: '<polygon points="0,30 62,30 62,0 100,50 62,100 62,70 0,70"/>',
  chevron: '<polygon points="0,0 75,0 100,50 75,100 0,100 25,50"/>',
  hexagon: '<polygon points="25,0 75,0 100,50 75,100 25,100 0,50"/>',
};

/** A hex color with opacity, for CSS. */
const rgba = (hex: Hex, a = 1) => (a >= 1 ? `#${hex}` : `rgba(${parseInt(hex.slice(0, 2), 16)},${parseInt(hex.slice(2, 4), 16)},${parseInt(hex.slice(4, 6), 16)},${a})`);
const cssFillA = (f: Fill, a = 1) => (typeof f === "string" ? rgba(f, a) : `linear-gradient(${(f.angle + 90) % 360}deg, ${rgba(f.from, a)}, ${rgba(f.to, a)})`);

let gradientSeq = 0;

function elementHtml(e: SlideElement, look: SlideLook): string {
  const pos = box(`${e.x}%`, `${e.y}%`, `${e.w}%`, `${e.h}%`, e.rotate ? `transform:rotate(${e.rotate}deg);` : "");
  const shape = e.type === "shape" ? (e.shape ?? "rect") : "rect";
  const a = e.opacity ?? 1;
  const border = e.border ? `${pt(e.borderWidth ?? 1)} solid #${e.border}` : "none";
  let back = "";
  if (shape === "line") {
    const c = e.border ?? (typeof e.fill === "string" ? e.fill : look.accent);
    back = `<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;overflow:visible"><line x1="0" y1="0" x2="100" y2="100" stroke="#${c}" stroke-width="${pt(e.borderWidth ?? 2)}" vector-effect="non-scaling-stroke"/></svg>`;
  } else if (SHAPE_SVG[shape]) {
    let fill = "none";
    let defs = "";
    if (e.fill) {
      if (typeof e.fill === "string") fill = rgba(e.fill, a);
      else {
        const id = `bg${++gradientSeq}`;
        const rad = (e.fill.angle * Math.PI) / 180;
        defs = `<defs><linearGradient id="${id}" x1="${50 - 50 * Math.cos(rad)}%" y1="${50 - 50 * Math.sin(rad)}%" x2="${50 + 50 * Math.cos(rad)}%" y2="${50 + 50 * Math.sin(rad)}%"><stop offset="0" stop-color="${rgba(e.fill.from, a)}"/><stop offset="1" stop-color="${rgba(e.fill.to, a)}"/></linearGradient></defs>`;
        fill = `url(#${id})`;
      }
    }
    const stroke = e.border ? ` stroke="#${e.border}" stroke-width="${e.borderWidth ?? 1}" vector-effect="non-scaling-stroke"` : "";
    back = `<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%" fill="${fill}"${stroke}>${defs}${SHAPE_SVG[shape]}</svg>`;
  } else {
    const radius = shape === "ellipse" ? "50%" : shape === "roundRect" ? pt(18) : "0";
    back = `<div style="position:absolute;inset:0;border-radius:${radius};border:${border};${e.fill ? `background:${cssFillA(e.fill, a)};` : ""}"></div>`;
  }
  let text = "";
  if (e.text) {
    const color = e.color ?? (e.fill ? readable(look.text, e.fill, 3) : look.text);
    const v = e.valign === "bottom" ? "flex-end" : e.valign === "top" ? "flex-start" : e.type === "shape" ? "center" : "flex-start";
    text = `<div style="position:absolute;inset:0;padding:${pt(3.6)};display:flex;flex-direction:column;justify-content:${v};text-align:${e.align ?? "left"};color:#${color};font-family:${cssFont(e.font ?? look.bodyFont)};font-size:${pt(e.size ?? 18 * look.scale)};${e.bold ? "font-weight:700;" : ""}${e.italic ? "font-style:italic;" : ""}line-height:1.15;white-space:pre-wrap;overflow:hidden">${e.text
      .split("\n")
      .map((l) => `<div>${inline(l)}</div>`)
      .join("")}</div>`;
  }
  return `<div style="${pos}">${back}${text}</div>`;
}

/** One slide, drawn like the file's: same look, layout and proportions. */
export function slideHtml(s: DocSlide, n: number, theme?: DeckTheme): string {
  const deck = deckLook(theme);
  const look = slideLook(deck, s);
  const center = look.align === "center";
  const ta = center ? "center" : "left";
  const scale = look.scale;
  const head = cssFont(look.headingFont);
  const bodyF = cssFont(look.bodyFont);
  const parts: string[] = [];
  const bar = (y: number, color: Hex, w = 0.9, ht = 0.07) =>
    parts.push(`<div style="${box(center ? `calc(50% - ${ix(w / 2)})` : ix(0.6), iy(y), ix(w), iy(ht), `background:#${color}`)}"></div>`);
  const coverDeco = (y: number) => {
    if (look.decoration === "none") return;
    if (look.decoration === "band") parts.push(`<div style="${box("0", "0", "100%", iy(0.22), `background:#${look.accent2}`)}"></div>`);
    else if (look.decoration === "frame") parts.push(`<div style="${box(ix(0.25), iy(0.25), `calc(100% - ${ix(0.5)})`, `calc(100% - ${iy(0.5)})`, `border:${pt(2.5)} solid #${look.accent2}`)}"></div>`);
    else bar(y, look.accent2);
  };
  const titleDeco = () => {
    if (look.decoration === "none") return;
    if (look.decoration === "underline") parts.push(`<div style="${box(ix(0.6), iy(1.42), `calc(100% - ${ix(1.2)})`, iy(0.025), `background:#${look.rule}`)}"></div>`);
    else if (look.decoration === "band") parts.push(`<div style="${box("0", "0", "100%", iy(0.16), `background:#${look.rule}`)}"></div>`);
    else if (look.decoration === "frame") parts.push(`<div style="${box(ix(0.2), iy(0.2), `calc(100% - ${ix(0.4)})`, `calc(100% - ${iy(0.4)})`, `border:${pt(2)} solid #${look.rule}`)}"></div>`);
    else bar(1.42, look.rule, 1.1, 0.05);
  };
  const textBox = (x: number, y: number, w: number, ht: number, inner: string, anchor: "flex-start" | "center" | "flex-end" = "flex-start") =>
    parts.push(`<div style="${box(ix(x), iy(y), ix(w), iy(ht), `display:flex;flex-direction:column;justify-content:${anchor};text-align:${ta};overflow:hidden`)}">${inner}</div>`);
  const title = (size: number, extra = "") => `<div style="font-family:${head};font-weight:700;font-size:${pt(size)};color:#${look.title};line-height:1.1;${extra}">${inline(s.title)}</div>`;
  const number = () =>
    parts.push(`<div style="${box(ix(11.733), iy(7.02), ix(1), iy(0.3), `display:flex;align-items:flex-end;justify-content:flex-end;font-size:${pt(11)};color:#${look.muted};font-family:${bodyF}`)}">${n}</div>`);
  const contentTitle = () => {
    textBox(0.6, 0.42, 12.133, 0.95, title(s.titleSize ?? Math.round(30 * scale)), "flex-end");
    titleDeco();
  };

  switch (s.layout) {
    case "title":
      coverDeco(2.2);
      textBox(0.6, 2.45, 12.133, 1.7, title(s.titleSize ?? Math.round((s.title.length > 60 ? 36 : 44) * scale)));
      if (s.subtitle) textBox(0.6, 4.3, 12.133, 1.1, `<div style="font-family:${bodyF};font-size:${pt(s.textSize ?? Math.round(20 * scale))};color:#${look.muted}">${inline(s.subtitle)}</div>`);
      break;
    case "section":
      coverDeco(2.75);
      textBox(0.6, 2.95, 12.133, 1.2, title(s.titleSize ?? Math.round(36 * scale)));
      if (s.subtitle) textBox(0.6, 4.2, 12.133, 0.9, `<div style="font-family:${bodyF};font-size:${pt(s.textSize ?? Math.round(18 * scale))};color:#${look.muted}">${inline(s.subtitle)}</div>`);
      number();
      break;
    case "quote": {
      const q = s.quote ?? s.title;
      const size = s.titleSize ?? Math.round((q.length > 400 ? 20 : q.length > 200 ? 24 : 32) * scale);
      coverDeco(1.6);
      textBox(0.6, 1.85, 12.133, 3, `<div style="font-family:${head};font-style:italic;font-size:${pt(size)};color:#${look.title};line-height:1.2">“${inline(q)}”</div>`, "center");
      if (s.attribution) textBox(0.6, 5.05, 12.133, 0.7, `<div style="font-family:${bodyF};font-size:${pt(s.textSize ?? Math.round(18 * scale))};color:#${look.muted}">— ${inline(s.attribution)}</div>`);
      number();
      break;
    }
    case "bullets": {
      const bullets = s.bullets ?? [];
      const lines = bullets.reduce((k, b) => k + 1 + (b.sub?.length ?? 0), 0);
      const chars = bullets.reduce((k, b) => k + b.text.length + (b.sub ?? []).reduce((m, x) => m + x.length, 0), 0);
      const size = s.textSize ?? Math.round(bulletPoints(lines, chars, false) * scale);
      contentTitle();
      const intro = s.subtitle ? `<div style="font-style:italic;color:#${look.muted};font-size:${pt(Math.max(12, size - 2))};margin-bottom:${pt(size * 0.6)}">${inline(s.subtitle)}</div>` : "";
      textBox(0.6, 1.7, 12.133, 5.2, `<div style="font-family:${bodyF};font-size:${pt(size)};color:#${look.text};line-height:1.2">${intro}${bulletsHtml(bullets, size, look, center)}</div>`);
      number();
      break;
    }
    case "two-column": {
      const cols = [s.left ?? { bullets: [] }, s.right ?? { bullets: [] }];
      const size =
        s.textSize ??
        Math.round(
          Math.min(
            ...cols.map((c) =>
              bulletPoints(
                c.bullets.reduce((k, b) => k + 1 + (b.sub?.length ?? 0), 0),
                c.bullets.reduce((k, b) => k + b.text.length, 0),
                true
              )
            ),
            22
          ) * scale
        );
      contentTitle();
      cols.forEach((c, i) =>
        textBox(
          i ? 0.6 + 5.8417 + 0.45 : 0.6,
          1.7,
          5.8417,
          5.2,
          `<div style="font-family:${bodyF};font-size:${pt(size)};color:#${look.text};line-height:1.2">${
            c.heading ? `<div style="font-family:${head};font-weight:700;color:#${look.accent};font-size:${pt(size + 2)};margin-bottom:${pt(size * 0.6)}">${inline(c.heading)}</div>` : ""
          }${bulletsHtml(c.bullets, size, look, center)}</div>`
        )
      );
      parts.push(`<div style="${box(ix(0.6 + 5.8417 + 0.225), iy(1.7), "1px", iy(5.2 * 0.85), `background:#${mix(look.text, solidOf(look.bg), 0.75)}`)}"></div>`);
      number();
      break;
    }
    case "table": {
      contentTitle();
      const cols = s.columns ?? [];
      const rows = s.rows ?? [];
      const size = s.textSize ?? Math.round((rows.length > 12 ? 10 : rows.length > 6 || cols.length > 4 ? 12 : 14) * scale);
      const bg = solidOf(look.bg);
      const border = mix(look.text, bg, 0.75);
      const band = mix(look.text, bg, 0.93);
      const headText = readable("FFFFFF", look.accent, 3);
      const cell = (t: string, head: boolean, stripe: boolean) =>
        `<${head ? "th" : "td"} style="border:1px solid #${border};padding:${pt(3.6)} ${pt(7.2)};text-align:left;${head ? `background:#${look.accent};color:#${headText};font-weight:700` : `background:#${stripe ? band : bg};color:#${readable(look.text, stripe ? band : bg, 4.5)}`}">${inline(t)}</${head ? "th" : "td"}>`;
      textBox(
        0.6,
        1.7,
        12.133,
        5.2,
        `<table style="border-collapse:collapse;width:100%;font-family:${bodyF};font-size:${pt(size)}"><tr>${cols.map((c) => cell(c, true, false)).join("")}</tr>${rows
          .map((r, i) => `<tr>${cols.map((_, c) => cell(r[c] ?? "", false, i % 2 === 1)).join("")}</tr>`)
          .join("")}</table>`
      );
      number();
      break;
    }
    case "stat": {
      contentTitle();
      const stats = s.stats ?? [];
      const perRow = stats.length <= 3 ? stats.length : stats.length === 4 ? 2 : 3;
      const rowsN = Math.ceil(stats.length / Math.max(1, perRow));
      const valueSize = s.titleSize ? Math.round(s.titleSize * 1.4) : Math.round((rowsN > 1 ? 40 : 54) * scale);
      const labelSize = s.textSize ?? Math.round(16 * scale);
      textBox(
        0.6,
        1.7,
        12.133,
        5.2,
        `<div style="display:grid;grid-template-columns:repeat(${Math.max(1, perRow)},1fr);gap:${pt(14)};align-content:center;height:100%">${stats
          .map(
            (x) =>
              `<div style="text-align:center"><div style="font-family:${head};font-weight:700;font-size:${pt(valueSize)};color:#${look.accent};line-height:1">${h(x.value)}</div>${
                x.label ? `<div style="margin-top:${pt(6)};font-family:${bodyF};font-size:${pt(labelSize)};color:#${look.text}">${inline(x.label)}</div>` : ""
              }</div>`
          )
          .join("")}</div>`
      );
      number();
      break;
    }
    case "blank":
      if (s.title) contentTitle();
      number();
      break;
  }
  for (const e of s.elements ?? []) parts.push(elementHtml(e, look));
  return `<div class="brew-slide" style="position:relative;aspect-ratio:16/9;width:100%;overflow:hidden;container-type:inline-size;background:${cssFill(look.bg)};font-family:${bodyF};color:#${look.text}">${parts.join("")}</div>`;
}

/* ---------------------------------- word ---------------------------------- */

const HEADING_SCALE = [1.45, 1.18, 1.09, 1, 1, 1];

function listHtml(items: ListItem[], look: DocLook): string {
  const counters: number[] = [];
  const marks = ["•", "◦", "▪"];
  return items
    .map((it) => {
      counters.length = it.level + 1;
      let mark: string;
      if (it.ordered) {
        counters[it.level] = it.start ?? (counters[it.level] ?? 0) + 1;
        const n = counters[it.level];
        mark = it.level % 3 === 1 ? `${String.fromCharCode(96 + ((n - 1) % 26) + 1)}.` : it.level % 3 === 2 ? `${toRoman(n)}.` : `${n}.`;
      } else {
        counters[it.level] = 0;
        mark = `<span style="color:#${look.accent}">${marks[it.level % 3]}</span>`;
      }
      return `<div style="display:flex;gap:0.5em;margin:0.15em 0 0.15em ${1.4 + it.level * 1.4}em"><span style="min-width:1.1em;text-align:right">${mark}</span><span style="flex:1">${runsHtml(it.inlines)}</span></div>`;
    })
    .join("");
}

function toRoman(n: number): string {
  const map: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let out = "";
  for (const [v, s] of map) while (n >= v) (out += s), (n -= v);
  return out;
}

/** A Word document's preview: its page, fonts, colors, headings, lists, tables and breaks. */
export function docHtml(markdown: string, style?: DocStyle): string {
  const look = docLook(style);
  const blocks = parseBlocks(markdown);
  const h1s = blocks.filter((b) => b.type === "heading" && b.level === 1).length;
  const titleFirst = blocks[0]?.type === "heading" && blocks[0].level === 1 && h1s === 1;
  const coverEnd = look.coverPage && titleFirst ? (blocks[1]?.type === "paragraph" ? 1 : 0) : -1;
  const pageBreak = `<div style="margin:1.4em -1em;border-top:1px dashed #${mix(look.text, look.pageColor ?? "FFFFFF", 0.6)};text-align:center;font-size:0.75em;color:#${mix(look.text, look.pageColor ?? "FFFFFF", 0.45)}"><span style="position:relative;top:-0.75em;padding:0 0.6em;background:#${look.pageColor ?? "FFFFFF"}">Page break</span></div>`;
  const align = (a?: string) => (a ? `text-align:${a};` : "");
  const html = blocks
    .map((b, i) => {
      const after = i === coverEnd ? pageBreak : "";
      switch (b.type) {
        case "heading": {
          const isTitle = i === 0 && titleFirst;
          const level = isTitle ? 0 : Math.min(b.level - (titleFirst ? 1 : 0), 6) || 1;
          if (isTitle)
            return `<div style="font-family:${cssFont(look.headingFont)};font-size:${(2.36).toFixed(2)}em;color:#${look.title};line-height:1.15;padding-bottom:0.25em;margin:${look.coverPage ? "3em" : "0"} 0 0.6em;border-bottom:2px solid #${look.accent};${align(b.align ?? look.titleAlign)}">${runsHtml(b.inlines)}</div>${after}`;
          return `<div style="font-family:${cssFont(look.headingFont)};font-weight:700;font-size:${HEADING_SCALE[level - 1]}em;color:#${level === 1 ? look.heading : look.subheading};margin:${level === 1 ? "1.1em" : "0.9em"} 0 0.35em;${align(b.align)}">${runsHtml(b.inlines)}</div>${after}`;
        }
        case "paragraph": {
          const subtitle = i === coverEnd && i === 1;
          return `<p style="margin:0 0 0.65em;${align(b.align ?? (subtitle ? look.titleAlign : look.align === "justify" ? "justify" : look.align))}${subtitle ? `font-size:1.27em;color:#${look.subheading};` : ""}">${runsHtml(b.inlines)}</p>${after}`;
        }
        case "list":
          return `<div style="margin:0 0 0.65em">${listHtml(b.items, look)}</div>`;
        case "code":
          return `<pre style="background:#F3F4F6;color:#1F2937;padding:0.6em 0.8em;border-radius:4px;font-family:Consolas,Menlo,monospace;font-size:0.86em;white-space:pre-wrap;margin:0 0 0.65em">${h(b.text)}</pre>`;
        case "quote":
          return `<div style="border-left:4px solid #${look.accent};padding:0.1em 0 0.1em 0.9em;margin:0.5em 1em;font-style:italic">${b.paragraphs.map((p) => `<p style="margin:0.3em 0">${runsHtml(p)}</p>`).join("")}</div>`;
        case "table":
          return `<table style="border-collapse:collapse;width:100%;margin:0 0 0.8em;font-size:0.91em">${[b.header, ...b.rows]
            .map(
              (row, r) =>
                `<tr>${row
                  .map((c, ci) => {
                    const head = r === 0;
                    const fill = head ? look.tableHeader : look.tableStripe && r % 2 === 0 ? look.tableStripe : undefined;
                    return `<${head ? "th" : "td"} style="border:1px solid #${look.tableBorder};padding:0.3em 0.5em;text-align:${b.align[ci] ?? "left"};${fill ? `background:#${fill};` : ""}${head ? `color:#${look.tableHeaderText};font-weight:700;` : ""}">${runsHtml(c)}</${head ? "th" : "td"}>`;
                  })
                  .join("")}</tr>`
            )
            .join("")}</table>`;
        case "rule":
          return `<hr style="border:0;border-top:1px solid #${look.tableBorder};margin:0.8em 0">`;
        case "pagebreak":
          return pageBreak;
      }
    })
    .join("");
  const page = look.pageColor ?? "FFFFFF";
  const small = `font-size:0.75em;color:#${look.subheading}`;
  const header = look.header ? `<div style="text-align:right;${small};margin-bottom:1.2em">${h(look.header)}</div>` : "";
  const footerText = [look.footer ? h(look.footer) : "", look.pageNumbers ? "1" : ""].filter(Boolean).join("  ·  ");
  const footer = footerText ? `<div style="text-align:center;${small};margin-top:1.6em">${footerText}</div>` : "";
  return `<div class="brew-page" style="background:#${page};color:#${look.text};font-family:${cssFont(look.font)};font-size:${(look.size / 11).toFixed(3)}em;line-height:${(look.lineSpacing * 1.3).toFixed(2)};padding:${(1.4 * look.margins).toFixed(2)}em ${(1.6 * look.margins).toFixed(2)}em;border-radius:6px;box-shadow:0 1px 3px rgb(0 0 0 / 0.12)">${header}${html}${footer}</div>`;
}

/* ---------------------------------- excel --------------------------------- */

/** A sheet as a grid: column letters, row numbers, its styles and merges, values as shown. */
export function sheetHtml(sh: DocSheet, shown: string[][], book?: SheetStyle): string {
  const look = sheetLook(book, sh.style);
  const width = Math.max(1, ...shown.map((r) => r.length));
  const covered = new Set<string>();
  const spans = new Map<string, { cols: number; rows: number }>();
  for (const m of sh.merge ?? []) {
    const [a, b] = m.split(":");
    const p = /^([A-Z]+)(\d+)$/.exec(a);
    const q = /^([A-Z]+)(\d+)$/.exec(b);
    if (!p || !q) continue;
    const col = (s: string) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    const [r1, c1, r2, c2] = [Number(p[2]) - 1, col(p[1]), Number(q[2]) - 1, col(q[1])];
    spans.set(a1Name(r1, c1), { cols: c2 - c1 + 1, rows: r2 - r1 + 1 });
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (r !== r1 || c !== c1) covered.add(a1Name(r, c));
  }
  const letters = Array.from({ length: width }, (_, c) => a1Name(0, c).replace(/\d+$/, ""));
  const grid = sh.columns.length ? [sh.columns, ...sh.rows] : sh.rows;
  const rowsHtml = shown
    .map((row, r) => {
      const header = sh.columns.length > 0 && r === 0;
      const dataRow = r - (sh.columns.length ? 1 : 0);
      const cells = Array.from({ length: width }, (_, c) => {
        const key = a1Name(r, c);
        if (covered.has(key)) return "";
        const own = sh.styles?.[key] ?? {};
        const raw = grid[r]?.[c];
        const formula = typeof raw === "string" && /^=\s*\S/.test(raw) ? raw : null;
        const fill = own.fill ?? (header ? look.headerFill : look.stripe && dataRow % 2 === 1 ? look.stripe : undefined);
        const base = header ? look.headerText : "111827";
        const color = own.color ?? (fill ? readable(base, fill, 3) : base);
        const fmt = cellFormat(sh, r, c);
        const numeric = typeof raw === "number" || (formula !== null && /^[-+]?[^\d]{0,4}[\d,.]+[%]?[^\d]{0,8}$/.test(row[c] ?? "") && fmt?.kind !== "text");
        const alignTo = own.align ?? (header ? "left" : sh.align?.[c]) ?? (numeric ? "right" : "left");
        const span = spans.get(key);
        const css = [
          `color:#${color}`,
          fill ? `background:#${fill}` : "",
          own.bold ?? (header && look.headerBold) ? "font-weight:700" : "",
          own.italic ? "font-style:italic" : "",
          own.underline ? "text-decoration:underline" : "",
          own.font ? `font-family:${cssFont(own.font)}` : "",
          own.size ? `font-size:${(own.size / look.size).toFixed(2)}em` : "",
          `text-align:${alignTo}`,
          own.valign ? `vertical-align:${own.valign}` : "",
          own.wrap || (row[c] ?? "").length > 60 ? "white-space:pre-wrap;min-width:14em" : "white-space:nowrap",
          (own.border ?? look.border) ? `border:1px solid #${own.border ?? look.border}` : "",
        ]
          .filter(Boolean)
          .join(";");
        return `<td${span ? `${span.cols > 1 ? ` colspan="${span.cols}"` : ""}${span.rows > 1 ? ` rowspan="${span.rows}"` : ""}` : ""}${formula ? ` title="${h(formula)}" data-fx="1"` : ""} style="${css}">${h(row[c] ?? "")}</td>`;
      }).join("");
      return `<tr><th class="rn">${r + 1}</th>${cells}</tr>`;
    })
    .join("");
  return `<table class="brew-sheet" style="font-family:${cssFont(look.font)};border-collapse:collapse"><thead><tr><th class="rn"></th>${letters.map((l) => `<th>${l}</th>`).join("")}</tr></thead><tbody>${rowsHtml}</tbody></table>`;
}

/** Each sheet's tab color, if it has one. */
export const tabColor = (sh: DocSheet, book?: SheetStyle): Hex | undefined => sheetLook(book, sh.style).tabColor;
