/**
 * Slides → a PowerPoint file (.pptx), 16:9, in whatever look the request
 * asked for (look.ts): the theme's colors, gradients and fonts, title
 * decorations, left or centered text, per-slide overrides, and free-form
 * shapes and text boxes on top. Titles and bodies are real placeholders, so
 * PowerPoint's outline, Designer and "Reset slide" treat them as its own,
 * and the file's own theme and masters carry the look, so slides added in
 * PowerPoint match.
 */
import type { DocBullet, DocColumn, DocSlide, DeckTheme, SlideElement } from "../document";
import { bulletPoints, deckLook, slideLook, type DeckLook, type SlideLook } from "./look";
import { parseInline, type Inline } from "./mdblocks";
import { drawingFill, mix, readable, solidOf, type Fill, type Hex } from "./style";
import { appProps, contentTypes, coreProps, CT, esc, rels, XML_HEAD, zipParts } from "./xml";

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const PML = "application/vnd.openxmlformats-officedocument.presentationml.";

/* --------------------------------- layout --------------------------------- */

const W = 12192000;
const H = 6858000;
const IN = 914400;
const MARGIN = Math.round(0.6 * IN);
const CONTENT_W = W - 2 * MARGIN;
const TITLE_Y = Math.round(0.42 * IN);
const TITLE_H = Math.round(0.95 * IN);
const RULE_Y = Math.round(1.42 * IN);
const BODY_Y = Math.round(1.7 * IN);
const BODY_H = H - BODY_Y - Math.round(0.6 * IN);
const GAP = Math.round(0.45 * IN);
const HALF_W = Math.round((CONTENT_W - GAP) / 2);

/** One field id for every slide number (PowerPoint renumbers them itself). */
const SLIDENUM_ID = "{8A5D0F3B-6C1E-4C55-9D7B-2F3E4A5B6C7D}";

type Box = { x: number; y: number; w: number; h: number };
const xfrm = (b: Box, rot = 0) =>
  `<a:xfrm${rot ? ` rot="${Math.round(rot * 60000)}"` : ""}><a:off x="${Math.round(b.x)}" y="${Math.round(b.y)}"/><a:ext cx="${Math.max(1, Math.round(b.w))}" cy="${Math.max(1, Math.round(b.h))}"/></a:xfrm>`;
const solid = (hex: Hex) => `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`;

/**
 * Marks a shape as decoration, as PowerPoint's own "Mark as Decorative" does,
 * so its accessibility checker and screen readers skip it (older versions
 * ignore the extension).
 */
const DECORATIVE =
  '<a:extLst><a:ext uri="{C183D7F6-B498-43B3-948B-1728B52AA6E4}"><adec:decorative xmlns:adec="http://schemas.microsoft.com/office/drawing/2017/decorative" val="1"/></a:ext></a:extLst>';

/* ---------------------------------- text ---------------------------------- */

interface RunStyle {
  /** Points. */
  size: number;
  color: Hex;
  font: string;
  bold?: boolean;
  italic?: boolean;
}

/** Inline runs in the slide's size, color and font; **bold** and *italic* from the text kept. */
function runsXml(inlines: Inline[], st: RunStyle): string {
  return inlines
    .map((r) => {
      const text = r.text.replace(/\s*\n\s*/g, " ");
      if (!text) return "";
      const size = Math.round(Math.max(1, st.size) * 100);
      const attrs = `lang="en-US" sz="${size}"${st.bold || r.bold ? ' b="1"' : ""}${st.italic || r.italic ? ' i="1"' : ""}${r.underline ? ' u="sng"' : ""}${r.strike ? ' strike="sngStrike"' : ""} dirty="0"`;
      const face = r.code ? "Consolas" : st.font;
      return `<a:r><a:rPr ${attrs}>${solid(r.color ?? st.color)}<a:latin typeface="${esc(face)}"/><a:cs typeface="${esc(face)}"/></a:rPr><a:t>${esc(text)}</a:t></a:r>`;
    })
    .join("");
}

interface ParaOpts extends RunStyle {
  /** Bullet depth (0, 1) or none. */
  level?: number;
  align?: "l" | "ctr" | "r";
  /** Space before, in points. */
  before?: number;
  /** Bullet color. */
  marker?: Hex;
  /** Line spacing, percent. */
  line?: number;
}

function para(text: string | Inline[], o: ParaOpts): string {
  const inlines = typeof text === "string" ? parseInline(text) : text;
  const bullet = o.level !== undefined;
  const marL = bullet ? (o.level === 0 ? 342900 : 742950) : 0;
  const indent = bullet ? -285750 : 0;
  const ppr =
    `<a:pPr marL="${marL}" indent="${indent}"${bullet ? ` lvl="${o.level}"` : ""}${o.align ? ` algn="${o.align}"` : ""}>` +
    `<a:lnSpc><a:spcPct val="${(o.line ?? (bullet ? 100 : 95)) * 1000}"/></a:lnSpc>` +
    `<a:spcBef><a:spcPts val="${Math.round((o.before ?? 0) * 100)}"/></a:spcBef>` +
    (bullet
      ? `<a:buClr><a:srgbClr val="${o.marker ?? o.color}"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="${o.level === 0 ? "•" : "–"}"/>`
      : "<a:buNone/>") +
    "</a:pPr>";
  return `<a:p>${ppr}${runsXml(inlines, o)}<a:endParaRPr lang="en-US" sz="${Math.round(o.size * 100)}" dirty="0"/></a:p>`;
}

/** A shape: a placeholder (`ph`) or a plain text box, with its paragraphs. */
function textShape(id: number, name: string, ph: string | null, box: Box, paras: string, anchor: "t" | "ctr" | "b" = "t"): string {
  const nv = ph ? `<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr>` : '<p:cNvSpPr txBox="1"/><p:nvPr/>';
  const geom = ph ? "" : '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/>${nv}</p:nvSpPr><p:spPr>${xfrm(box)}${geom}</p:spPr><p:txBody><a:bodyPr vert="horz" wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${
    paras || '<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>'
  }</p:txBody></p:sp>`;
}

/** A plain colored shape (rules, bands, frames): decoration only. */
function deco(id: number, name: string, box: Box, fill: Fill | null, line?: { color: Hex; pt: number }): string {
  const ln = line ? `<a:ln w="${Math.round(line.pt * 12700)}">${solid(line.color)}</a:ln>` : "<a:ln><a:noFill/></a:ln>";
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}">${DECORATIVE}</p:cNvPr><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${
    fill ? drawingFill(fill) : "<a:noFill/>"
  }${ln}</p:spPr></p:sp>`;
}

function slideNumber(id: number, n: number, look: SlideLook): string {
  const box = { x: W - MARGIN - IN, y: H - Math.round(0.48 * IN), w: IN, h: Math.round(0.3 * IN) };
  const p = `<a:p><a:pPr algn="r"/><a:fld id="${SLIDENUM_ID}" type="slidenum"><a:rPr lang="en-US" sz="1100" dirty="0">${solid(look.muted)}<a:latin typeface="${esc(look.bodyFont)}"/></a:rPr><a:t>${n}</a:t></a:fld><a:endParaRPr lang="en-US" sz="1100" dirty="0"/></a:p>`;
  return textShape(id, `Slide Number ${id}`, null, box, p, "b");
}

const lineCount = (bullets: DocBullet[]) => bullets.reduce((n, b) => n + 1 + (b.sub?.length ?? 0), 0);
const charCount = (bullets: DocBullet[]) => bullets.reduce((n, b) => n + b.text.length + (b.sub ?? []).reduce((k, x) => k + x.length, 0), 0);

/** Bullets and their sub-points. `first`: space above the first one, in points (after a heading). */
function bulletParas(bullets: DocBullet[], size: number, look: SlideLook, algn?: "ctr", first = 0): string {
  const sub = Math.max(10, Math.round(size * 0.82));
  return bullets
    .map(
      (b, i) =>
        para(b.text, { size, color: look.text, font: look.bodyFont, level: 0, marker: look.accent, align: algn, before: i === 0 ? first : Math.round(size * 0.55) }) +
        (b.sub ?? [])
          .map((x) => para(x, { size: sub, color: look.muted, font: look.bodyFont, level: 1, marker: look.muted, align: algn, before: Math.round(sub * 0.3) }))
          .join("")
    )
    .join("");
}

/* --------------------------------- slides --------------------------------- */

const bgXml = (f: Fill) => `<p:bg><p:bgPr>${drawingFill(f)}<a:effectLst/></p:bgPr></p:bg>`;

/** Layout parts (1-based, see layouts()). */
const LAYOUT = { title: 1, content: 2, section: 3, two: 4, titleOnly: 5, blank: 6 } as const;

function layoutOf(s: DocSlide): number {
  switch (s.layout) {
    case "title":
      return LAYOUT.title;
    case "bullets":
      return LAYOUT.content;
    case "section":
    case "quote":
      return LAYOUT.section;
    case "two-column":
      return LAYOUT.two;
    case "table":
    case "stat":
      return LAYOUT.titleOnly;
    case "blank":
      return s.title ? LAYOUT.titleOnly : LAYOUT.blank;
  }
}

/** The decoration that marks a content slide's title. */
function titleDecoration(look: SlideLook, center: boolean): string {
  const w = Math.round(1.1 * IN);
  switch (look.decoration) {
    case "none":
      return "";
    case "underline":
      return deco(4, "Accent", { x: MARGIN, y: RULE_Y, w: CONTENT_W, h: Math.round(0.025 * IN) }, look.rule);
    case "band":
      return deco(4, "Accent", { x: 0, y: 0, w: W, h: Math.round(0.16 * IN) }, look.rule);
    case "frame":
      return deco(4, "Frame", { x: Math.round(0.2 * IN), y: Math.round(0.2 * IN), w: W - Math.round(0.4 * IN), h: H - Math.round(0.4 * IN) }, null, { color: look.rule, pt: 2 });
    default:
      return deco(4, "Accent", { x: center ? (W - w) / 2 : MARGIN, y: RULE_Y, w, h: Math.round(0.05 * IN) }, look.rule);
  }
}

/** The decoration on a cover slide (title, section, quote), above where its text starts. */
function coverDecoration(look: SlideLook, y: number, center: boolean): string {
  const w = Math.round(0.9 * IN);
  switch (look.decoration) {
    case "none":
      return "";
    case "band":
      return deco(4, "Accent", { x: 0, y: 0, w: W, h: Math.round(0.22 * IN) }, look.accent2);
    case "frame":
      return deco(4, "Frame", { x: Math.round(0.25 * IN), y: Math.round(0.25 * IN), w: W - Math.round(0.5 * IN), h: H - Math.round(0.5 * IN) }, null, { color: look.accent2, pt: 2.5 });
    default:
      return deco(4, "Accent", { x: center ? (W - w) / 2 : MARGIN, y, w, h: Math.round(0.07 * IN) }, look.accent2);
  }
}

function titleShape(s: DocSlide, look: SlideLook, algn?: "ctr"): string {
  const size = s.titleSize ?? Math.round(30 * look.scale);
  return textShape(2, "Title 1", '<p:ph type="title"/>', { x: MARGIN, y: TITLE_Y, w: CONTENT_W, h: TITLE_H }, para(s.title, { size, color: look.title, font: look.headingFont, bold: true, align: algn }), "b");
}

const SHAPE_GEOM: Record<string, string> = {
  rect: "rect",
  roundRect: "roundRect",
  ellipse: "ellipse",
  triangle: "triangle",
  diamond: "diamond",
  star: "star5",
  heart: "heart",
  arrow: "rightArrow",
  chevron: "chevron",
  hexagon: "hexagon",
  line: "line",
};

/** A free element: a text box or a shape (with optional text), placed in percent of the slide. */
function elementXml(e: SlideElement, id: number, look: SlideLook): string {
  const box = { x: (e.x / 100) * W, y: (e.y / 100) * H, w: (e.w / 100) * W, h: (e.h / 100) * H };
  const geom = e.type === "shape" ? (SHAPE_GEOM[e.shape ?? "rect"] ?? "rect") : "rect";
  const isLine = geom === "line";
  const fill = isLine ? "<a:noFill/>" : e.fill ? drawingFill(e.fill, e.opacity) : "<a:noFill/>";
  const lineColor = e.border ?? (isLine ? (typeof e.fill === "string" ? e.fill : look.accent) : undefined);
  const ln = lineColor ? `<a:ln w="${Math.round((e.borderWidth ?? (isLine ? 2 : 1)) * 12700)}">${solid(lineColor)}</a:ln>` : "<a:ln><a:noFill/></a:ln>";
  const algn = e.align === "center" ? "ctr" : e.align === "right" ? "r" : "l";
  const anchor = e.valign === "bottom" ? "b" : e.valign === "top" ? "t" : e.type === "shape" ? "ctr" : "t";
  const textColor = e.color ?? (e.fill ? readable(look.text, e.fill, 3) : look.text);
  const paras = e.text
    ? e.text
        .split(/\n/)
        .map((line) => para(line, { size: e.size ?? Math.round(18 * look.scale), color: textColor, font: e.font ?? look.bodyFont, bold: e.bold, italic: e.italic, align: algn, line: 100 }))
        .join("")
    : "";
  const name = e.type === "text" ? `TextBox ${id}` : `Shape ${id}`;
  // Shapes without words are decoration; anything with text is read out.
  const cNvPr = e.text ? `<p:cNvPr id="${id}" name="${name}"/>` : `<p:cNvPr id="${id}" name="${name}">${DECORATIVE}</p:cNvPr>`;
  const nv = `${cNvPr}<p:cNvSpPr${e.type === "text" ? ' txBox="1"' : ""}/><p:nvPr/>`;
  const body = paras
    ? `<p:txBody><a:bodyPr vert="horz" wrap="square" lIns="45720" tIns="45720" rIns="45720" bIns="45720" rtlCol="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody>`
    : "";
  return `<p:sp><p:nvSpPr>${nv}</p:nvSpPr><p:spPr>${xfrm(box, e.rotate ?? 0)}<a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom>${fill}${ln}</p:spPr>${body}</p:sp>`;
}

function slideXml(s: DocSlide, n: number, deck: DeckLook): string {
  const look = slideLook(deck, s);
  const center = look.align === "center";
  const algn = center ? "ctr" : undefined;
  const shapes: string[] = [];
  const scale = look.scale;
  switch (s.layout) {
    case "title": {
      const size = s.titleSize ?? Math.round((s.title.length > 60 ? 36 : 44) * scale);
      shapes.push(
        coverDecoration(look, Math.round(2.2 * IN), center),
        textShape(2, "Title 1", '<p:ph type="ctrTitle"/>', { x: MARGIN, y: Math.round(2.45 * IN), w: CONTENT_W, h: Math.round(1.7 * IN) }, para(s.title, { size, color: look.title, font: look.headingFont, bold: true, align: algn }), "t"),
        textShape(3, "Subtitle 2", '<p:ph type="subTitle" idx="1"/>', { x: MARGIN, y: Math.round(4.3 * IN), w: CONTENT_W, h: Math.round(1.1 * IN) }, s.subtitle ? para(s.subtitle, { size: s.textSize ?? Math.round(20 * scale), color: look.muted, font: look.bodyFont, align: algn }) : "", "t")
      );
      break;
    }
    case "section": {
      shapes.push(
        coverDecoration(look, Math.round(2.75 * IN), center),
        textShape(2, "Title 1", '<p:ph type="title"/>', { x: MARGIN, y: Math.round(2.95 * IN), w: CONTENT_W, h: Math.round(1.2 * IN) }, para(s.title, { size: s.titleSize ?? Math.round(36 * scale), color: look.title, font: look.headingFont, bold: true, align: algn }), "t"),
        textShape(3, "Text 2", '<p:ph type="body" idx="1"/>', { x: MARGIN, y: Math.round(4.2 * IN), w: CONTENT_W, h: Math.round(0.9 * IN) }, s.subtitle ? para(s.subtitle, { size: s.textSize ?? Math.round(18 * scale), color: look.muted, font: look.bodyFont, align: algn }) : "", "t")
      );
      break;
    }
    case "quote": {
      const q = s.quote ?? s.title;
      const size = s.titleSize ?? Math.round((q.length > 400 ? 20 : q.length > 200 ? 24 : 32) * scale);
      shapes.push(
        coverDecoration(look, Math.round(1.6 * IN), center),
        textShape(2, "Title 1", '<p:ph type="title"/>', { x: MARGIN, y: Math.round(1.85 * IN), w: CONTENT_W, h: Math.round(3 * IN) }, para(`“${q}”`, { size, color: look.title, font: look.headingFont, italic: true, align: algn, line: 110 }), "ctr"),
        textShape(3, "Text 2", '<p:ph type="body" idx="1"/>', { x: MARGIN, y: Math.round(5.05 * IN), w: CONTENT_W, h: Math.round(0.7 * IN) }, s.attribution ? para(`— ${s.attribution}`, { size: s.textSize ?? Math.round(18 * scale), color: look.muted, font: look.bodyFont, align: algn }) : "", "t")
      );
      break;
    }
    case "bullets": {
      const bullets = s.bullets ?? [];
      const size = s.textSize ?? Math.round(bulletPoints(lineCount(bullets), charCount(bullets), false) * scale);
      const intro = s.subtitle ? para(s.subtitle, { size: Math.max(12, size - 2), color: look.muted, font: look.bodyFont, italic: true, align: algn }) : "";
      shapes.push(
        titleShape(s, look, algn),
        titleDecoration(look, center),
        textShape(3, "Content 2", '<p:ph idx="1"/>', { x: MARGIN, y: BODY_Y, w: CONTENT_W, h: BODY_H }, intro + bulletParas(bullets, size, look, algn, s.subtitle ? Math.round(size * 0.6) : 0))
      );
      break;
    }
    case "two-column": {
      const cols = [s.left, s.right].map((c): DocColumn => c ?? { bullets: [] });
      const size = s.textSize ?? Math.round(Math.min(...cols.map((c) => bulletPoints(lineCount(c.bullets), charCount(c.bullets), true)), 22) * scale);
      const col = (c: DocColumn) =>
        (c.heading ? para(c.heading, { size: size + 2, color: look.accent, font: look.headingFont, bold: true, align: algn }) : "") +
        bulletParas(c.bullets, size, look, algn, c.heading ? Math.round(size * 0.6) : 0);
      shapes.push(
        titleShape(s, look, algn),
        titleDecoration(look, center),
        textShape(3, "Content 2", '<p:ph sz="half" idx="1"/>', { x: MARGIN, y: BODY_Y, w: HALF_W, h: BODY_H }, col(cols[0])),
        textShape(6, "Content 3", '<p:ph sz="half" idx="2"/>', { x: MARGIN + HALF_W + GAP, y: BODY_Y, w: HALF_W, h: BODY_H }, col(cols[1])),
        deco(7, "Divider", { x: MARGIN + HALF_W + Math.round(GAP / 2), y: BODY_Y, w: 9525, h: Math.round(BODY_H * 0.85) }, mix(look.text, solidOf(look.bg), 0.75))
      );
      break;
    }
    case "table": {
      shapes.push(titleShape(s, look, algn), titleDecoration(look, center), tableFrame(3, s.columns ?? [], s.rows ?? [], look, s.textSize));
      break;
    }
    case "stat": {
      const stats = s.stats ?? [];
      const perRow = stats.length <= 3 ? stats.length : stats.length === 4 ? 2 : 3;
      const rowsN = Math.ceil(stats.length / Math.max(1, perRow));
      const cellW = CONTENT_W / Math.max(1, perRow);
      const cellH = Math.min(Math.round(2.2 * IN), BODY_H / Math.max(1, rowsN));
      const top = BODY_Y + (BODY_H - cellH * rowsN) / 2;
      const valueSize = s.titleSize ? Math.round(s.titleSize * 1.4) : Math.round((rowsN > 1 ? 40 : 54) * scale);
      const labelSize = s.textSize ?? Math.round(16 * scale);
      shapes.push(titleShape(s, look, algn), titleDecoration(look, center));
      stats.forEach((st, i) => {
        const box = { x: MARGIN + (i % perRow) * cellW, y: top + Math.floor(i / perRow) * cellH, w: cellW - Math.round(0.2 * IN), h: cellH };
        const body =
          para(st.value, { size: valueSize, color: look.accent, font: look.headingFont, bold: true, align: "ctr", line: 100 }) +
          (st.label ? para(st.label, { size: labelSize, color: look.text, font: look.bodyFont, align: "ctr", before: 6 }) : "");
        shapes.push(textShape(10 + i, `Stat ${i + 1}`, null, box, body, "ctr"));
      });
      break;
    }
    case "blank": {
      if (s.title) shapes.push(titleShape(s, look, algn), titleDecoration(look, center));
      break;
    }
  }
  (s.elements ?? []).forEach((e, i) => shapes.push(elementXml(e, 100 + i, look)));
  // Last in reading order: screen readers reach the slide's own words first.
  if (s.layout !== "title") shapes.push(slideNumber(5, n, look));
  return `${XML_HEAD}<p:sld ${NS}><p:cSld>${bgXml(look.bg)}<p:spTree>${GROUP}${shapes.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

const GROUP =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

function tableFrame(id: number, columns: string[], rows: string[][], look: SlideLook, textSize?: number): string {
  const n = Math.max(1, columns.length);
  const many = rows.length > 6 || n > 4;
  const size = textSize ?? Math.round((rows.length > 12 ? 10 : many ? 12 : 14) * look.scale);
  const rowH = Math.round(Math.max(0.28, (size / 14) * 0.42) * IN);
  // Wider columns for longer text.
  const weights = columns.map((c, i) => Math.min(40, Math.max(6, c.length, ...rows.map((r) => (r[i] ?? "").length))));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const widths = weights.map((w) => Math.floor((CONTENT_W * w) / total));
  widths[widths.length - 1] += CONTENT_W - widths.reduce((a, b) => a + b, 0);
  const bg = solidOf(look.bg);
  const border = mix(look.text, bg, 0.75);
  const band = mix(look.text, bg, 0.93);
  const headFill = look.accent;
  const headText = readable("FFFFFF", headFill, 3);
  const line = (tag: string) => `<a:${tag} w="9525" cap="flat" cmpd="sng" algn="ctr">${solid(border)}<a:prstDash val="solid"/></a:${tag}>`;
  const cell = (text: string, head: boolean, stripe: boolean) => {
    const fillHex = head ? headFill : stripe ? band : bg;
    const color = head ? headText : readable(look.text, fillHex, 4.5);
    const body = text
      ? `<a:p><a:pPr marL="0" indent="0"><a:buNone/></a:pPr>${runsXml(parseInline(text), { size, color, font: look.bodyFont, bold: head })}<a:endParaRPr lang="en-US" sz="${size * 100}" dirty="0"/></a:p>`
      : `<a:p><a:endParaRPr lang="en-US" sz="${size * 100}" dirty="0"/></a:p>`;
    return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${body}</a:txBody><a:tcPr marL="91440" marR="91440" marT="45720" marB="45720" anchor="ctr">${line("lnL")}${line("lnR")}${line("lnT")}${line("lnB")}${solid(fillHex)}</a:tcPr></a:tc>`;
  };
  const trs = [
    `<a:tr h="${rowH}">${columns.map((c) => cell(c, true, false)).join("")}</a:tr>`,
    ...rows.map((r, i) => `<a:tr h="${rowH}">${columns.map((_, c) => cell(r[c] ?? "", false, i % 2 === 1)).join("")}</a:tr>`),
  ];
  const box = { x: MARGIN, y: BODY_Y, w: CONTENT_W, h: rowH * (rows.length + 1) };
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.w}" cy="${box.h}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${widths
    .map((w) => `<a:gridCol w="${w}"/>`)
    .join("")}</a:tblGrid>${trs.join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

function notesXml(notes: string): string {
  const paras = notes
    .split(/\n+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${esc(t)}</a:t></a:r></a:p>`)
    .join("");
  return `${XML_HEAD}<p:notes ${NS}><p:cSld><p:spTree>${GROUP}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
}

/* ---------------------------- masters & layouts ---------------------------- */

const placeholder = (id: number, name: string, ph: string, box: Box, prompt: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${xfrm(box)}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${prompt}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;

const TITLE_BOX = { x: MARGIN, y: TITLE_Y, w: CONTENT_W, h: TITLE_H };
const BODY_BOX = { x: MARGIN, y: BODY_Y, w: CONTENT_W, h: BODY_H };

function layouts(deck: DeckLook): { name: string; type: string; shapes: string; bg?: Fill }[] {
  return [
    {
      name: "Title Slide",
      type: "title",
      bg: deck.coverBackground,
      shapes:
        placeholder(2, "Title 1", '<p:ph type="ctrTitle"/>', { x: MARGIN, y: Math.round(2.45 * IN), w: CONTENT_W, h: Math.round(1.7 * IN) }, "Click to edit title") +
        placeholder(3, "Subtitle 2", '<p:ph type="subTitle" idx="1"/>', { x: MARGIN, y: Math.round(4.3 * IN), w: CONTENT_W, h: Math.round(1.1 * IN) }, "Click to edit subtitle"),
    },
    {
      name: "Title and Content",
      type: "obj",
      shapes: placeholder(2, "Title 1", '<p:ph type="title"/>', TITLE_BOX, "Click to edit title") + placeholder(3, "Content 2", '<p:ph idx="1"/>', BODY_BOX, "Click to edit text"),
    },
    {
      name: "Section Header",
      type: "secHead",
      bg: deck.coverBackground,
      shapes:
        placeholder(2, "Title 1", '<p:ph type="title"/>', { x: MARGIN, y: Math.round(2.95 * IN), w: CONTENT_W, h: Math.round(1.2 * IN) }, "Click to edit title") +
        placeholder(3, "Text 2", '<p:ph type="body" idx="1"/>', { x: MARGIN, y: Math.round(4.2 * IN), w: CONTENT_W, h: Math.round(0.9 * IN) }, "Click to edit text"),
    },
    {
      name: "Two Content",
      type: "twoObj",
      shapes:
        placeholder(2, "Title 1", '<p:ph type="title"/>', TITLE_BOX, "Click to edit title") +
        placeholder(3, "Content 2", '<p:ph sz="half" idx="1"/>', { x: MARGIN, y: BODY_Y, w: HALF_W, h: BODY_H }, "Click to edit text") +
        placeholder(4, "Content 3", '<p:ph sz="half" idx="2"/>', { x: MARGIN + HALF_W + GAP, y: BODY_Y, w: HALF_W, h: BODY_H }, "Click to edit text"),
    },
    {
      name: "Title Only",
      type: "titleOnly",
      shapes: placeholder(2, "Title 1", '<p:ph type="title"/>', TITLE_BOX, "Click to edit title"),
    },
    { name: "Blank", type: "blank", shapes: "" },
  ];
}

const layoutXml = (l: ReturnType<typeof layouts>[number]) =>
  `${XML_HEAD}<p:sldLayout ${NS} type="${l.type}" preserve="1"><p:cSld name="${l.name}">${l.bg ? bgXml(l.bg) : ""}<p:spTree>${GROUP}${l.shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

const CLR_MAP =
  'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';

const font = (kind: "mj" | "mn") => `<a:latin typeface="+${kind}-lt"/><a:ea typeface="+${kind}-ea"/><a:cs typeface="+${kind}-cs"/>`;

function masterXml(count: number): string {
  return `${XML_HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP}${placeholder(
    2,
    "Title Placeholder 1",
    '<p:ph type="title"/>',
    TITLE_BOX,
    "Click to edit Master title style"
  )}${placeholder(3, "Text Placeholder 2", '<p:ph type="body" idx="1"/>', BODY_BOX, "Click to edit Master text styles")}</p:spTree></p:cSld><p:clrMap ${CLR_MAP}/><p:sldLayoutIdLst>${Array.from(
    { length: count },
    (_, i) => `<p:sldLayoutId id="${2147483649 + i}" r:id="rId${i + 1}"/>`
  ).join("")}</p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/><a:defRPr sz="3000" b="1" kern="1200"><a:solidFill><a:schemeClr val="tx2"/></a:solidFill>${font(
    "mj"
  )}</a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle>${[0, 1, 2]
    .map(
      (i) =>
        `<a:lvl${i + 1}pPr marL="${342900 + i * 400050}" indent="-285750" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="100000"/></a:lnSpc><a:spcBef><a:spcPts val="${i === 0 ? 1000 : 500}"/></a:spcBef><a:buClr><a:schemeClr val="accent1"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="${i === 0 ? "•" : "–"}"/><a:defRPr sz="${[2400, 2000, 1800][i]}" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill>${font("mn")}</a:defRPr></a:lvl${i + 1}pPr>`
    )
    .join("")}</p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill>${font(
    "mn"
  )}</a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;
}

const NOTES_MASTER = `${XML_HEAD}<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="381000" y="685800"/><a:ext cx="6096000" cy="3429000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMap ${CLR_MAP}/><p:notesStyle><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill>${font(
  "mn"
)}</a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>`;

const solid3 = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3);

/** The file's theme: the deck's colors and fonts, so slides added in PowerPoint match it. */
function themeXml(deck: DeckLook, notes = false): string {
  const bg = notes ? "FFFFFF" : solidOf(deck.background);
  const text = notes ? "000000" : deck.text;
  const clr = (h: Hex) => `<a:srgbClr val="${h}"/>`;
  return `${XML_HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="BrewLM"><a:themeElements><a:clrScheme name="BrewLM"><a:dk1>${clr(text)}</a:dk1><a:lt1>${clr(bg)}</a:lt1><a:dk2>${clr(notes ? "000000" : deck.title)}</a:dk2><a:lt2>${clr(mix(bg, text, 0.06))}</a:lt2><a:accent1>${clr(deck.accent)}</a:accent1><a:accent2>${clr(deck.accent2)}</a:accent2><a:accent3><a:srgbClr val="10B981"/></a:accent3><a:accent4><a:srgbClr val="F59E0B"/></a:accent4><a:accent5><a:srgbClr val="8B5CF6"/></a:accent5><a:accent6><a:srgbClr val="EF4444"/></a:accent6><a:hlink>${clr(deck.accent)}</a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme><a:fontScheme name="BrewLM"><a:majorFont><a:latin typeface="${esc(deck.headingFont)}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${esc(deck.bodyFont)}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="BrewLM"><a:fillStyleLst>${solid3}</a:fillStyleLst><a:lnStyleLst>${[6350, 12700, 19050]
    .map((w) => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`)
    .join("")}</a:lnStyleLst><a:effectStyleLst>${"<a:effectStyle><a:effectLst/></a:effectStyle>".repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${solid3}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}

/* --------------------------------- package -------------------------------- */

export function buildPptx(slides: DocSlide[], opts: { title: string; date?: Date; theme?: DeckTheme }): Uint8Array {
  const deck = deckLook(opts.theme);
  const lays = layouts(deck);
  const n = slides.length;
  const parts: Record<string, string> = {};
  const overrides: Record<string, string> = {
    "/ppt/presentation.xml": `${PML}presentation.main+xml`,
    "/ppt/slideMasters/slideMaster1.xml": `${PML}slideMaster+xml`,
    "/ppt/notesMasters/notesMaster1.xml": `${PML}notesMaster+xml`,
    "/ppt/theme/theme1.xml": CT.theme,
    "/ppt/theme/theme2.xml": CT.theme,
    "/ppt/presProps.xml": `${PML}presProps+xml`,
    "/ppt/viewProps.xml": `${PML}viewProps+xml`,
    "/ppt/tableStyles.xml": `${PML}tableStyles+xml`,
    "/docProps/core.xml": CT.core,
    "/docProps/app.xml": CT.app,
  };
  lays.forEach((_, i) => (overrides[`/ppt/slideLayouts/slideLayout${i + 1}.xml`] = `${PML}slideLayout+xml`));

  slides.forEach((s, i) => {
    const k = i + 1;
    overrides[`/ppt/slides/slide${k}.xml`] = `${PML}slide+xml`;
    parts[`ppt/slides/slide${k}.xml`] = slideXml(s, k, deck);
    const slideRels = [{ id: "rId1", type: "slideLayout", target: `../slideLayouts/slideLayout${layoutOf(s)}.xml` }];
    if (s.notes) {
      overrides[`/ppt/notesSlides/notesSlide${k}.xml`] = `${PML}notesSlide+xml`;
      parts[`ppt/notesSlides/notesSlide${k}.xml`] = notesXml(s.notes);
      parts[`ppt/notesSlides/_rels/notesSlide${k}.xml.rels`] = rels([
        { id: "rId1", type: "notesMaster", target: "../notesMasters/notesMaster1.xml" },
        { id: "rId2", type: "slide", target: `../slides/slide${k}.xml` },
      ]);
      slideRels.push({ id: "rId2", type: "notesSlide", target: `../notesSlides/notesSlide${k}.xml` });
    }
    parts[`ppt/slides/_rels/slide${k}.xml.rels`] = rels(slideRels);
  });

  // presentation.xml.rels: master rId1, slides rId2…, then the rest.
  const rest = n + 2;
  const presentation = `${XML_HEAD}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId${rest}"/></p:notesMasterIdLst><p:sldIdLst>${slides
    .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`)
    .join("")}</p:sldIdLst><p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:defaultTextStyle></p:presentation>`;

  return zipParts({
    "[Content_Types].xml": contentTypes(overrides),
    "_rels/.rels": rels([
      { id: "rId1", type: "officeDocument", target: "ppt/presentation.xml" },
      { id: "rId2", type: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", target: "docProps/core.xml" },
      { id: "rId3", type: "extended-properties", target: "docProps/app.xml" },
    ]),
    "docProps/core.xml": coreProps(opts.title, opts.date ?? new Date()),
    "docProps/app.xml": appProps(),
    "ppt/presentation.xml": presentation,
    "ppt/_rels/presentation.xml.rels": rels([
      { id: "rId1", type: "slideMaster", target: "slideMasters/slideMaster1.xml" },
      ...slides.map((_, i) => ({ id: `rId${i + 2}`, type: "slide", target: `slides/slide${i + 1}.xml` })),
      { id: `rId${rest}`, type: "notesMaster", target: "notesMasters/notesMaster1.xml" },
      { id: `rId${rest + 1}`, type: "theme", target: "theme/theme1.xml" },
      { id: `rId${rest + 2}`, type: "presProps", target: "presProps.xml" },
      { id: `rId${rest + 3}`, type: "viewProps", target: "viewProps.xml" },
      { id: `rId${rest + 4}`, type: "tableStyles", target: "tableStyles.xml" },
    ]),
    "ppt/presProps.xml": `${XML_HEAD}<p:presentationPr ${NS}/>`,
    "ppt/viewProps.xml": `${XML_HEAD}<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`,
    "ppt/tableStyles.xml": `${XML_HEAD}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`,
    "ppt/slideMasters/slideMaster1.xml": masterXml(lays.length),
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": rels([
      ...lays.map((_, i) => ({ id: `rId${i + 1}`, type: "slideLayout", target: `../slideLayouts/slideLayout${i + 1}.xml` })),
      { id: `rId${lays.length + 1}`, type: "theme", target: "../theme/theme1.xml" },
    ]),
    ...Object.fromEntries(
      lays.flatMap((l, i) => [
        [`ppt/slideLayouts/slideLayout${i + 1}.xml`, layoutXml(l)],
        [`ppt/slideLayouts/_rels/slideLayout${i + 1}.xml.rels`, rels([{ id: "rId1", type: "slideMaster", target: "../slideMasters/slideMaster1.xml" }])],
      ])
    ),
    "ppt/notesMasters/notesMaster1.xml": NOTES_MASTER,
    "ppt/notesMasters/_rels/notesMaster1.xml.rels": rels([{ id: "rId1", type: "theme", target: "../theme/theme2.xml" }]),
    "ppt/theme/theme1.xml": themeXml(deck),
    "ppt/theme/theme2.xml": themeXml(deck, true),
    ...parts,
  });
}
