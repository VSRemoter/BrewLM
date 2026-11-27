/**
 * Markdown → a Word file (.docx), in the look its style block asked for
 * (look.ts docLook): fonts, colors, sizes, alignment, line spacing, page
 * color, paper, orientation, margins, a running header and footer with page
 * numbers, a cover page, and inline color, highlight, size, font, underline
 * and super/subscript. Headings are Word's own heading styles (so the
 * navigation pane and a table of contents work), lists are real lists, and
 * tables get a shaded header row. Element order inside each property block
 * follows the schema: Word is strict about it and calls the file damaged
 * otherwise.
 */
import type { DocStyle } from "../document";
import { docLook, type DocLook } from "./look";
import { parseBlocks, type Align, type Block, type Inline, type ListItem } from "./mdblocks";
import { appProps, contentTypes, coreProps, esc, rels, XML_HEAD, zipParts } from "./xml";

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

export interface DocxOptions {
  title: string;
  date?: Date;
  style?: DocStyle;
}

/** Letter in the US, Canada, Mexico and the Philippines; A4 elsewhere. */
export function defaultPaper(): "letter" | "a4" {
  const lang = typeof navigator !== "undefined" ? navigator.language : "en-US";
  return /^[a-z]{2,3}-(US|CA|MX|PH)$/i.test(lang) || lang === "en" ? "letter" : "a4";
}

/** Text with newlines and tabs as Word's own breaks. */
function textRuns(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .split("\t")
        .map((part) => (part ? `<w:t xml:space="preserve">${esc(part)}</w:t>` : ""))
        .join("<w:tab/>")
    )
    .join("<w:br/>");
}

const JC: Record<Align, string> = { left: "left", center: "center", right: "right", justify: "both" };
const jc = (a?: Align) => (a ? `<w:jc w:val="${JC[a]}"/>` : "");

/** Page size and usable width (twips) for the look. */
function page(look: DocLook) {
  const paper = look.paper ?? defaultPaper();
  const [w, h] = paper === "letter" ? [12240, 15840] : [11906, 16838];
  const landscape = look.orientation === "landscape";
  const margin = Math.round(look.margins * 1440);
  const width = landscape ? h : w;
  return {
    xml: `<w:pgSz w:w="${landscape ? h : w}" w:h="${landscape ? w : h}"${landscape ? ' w:orient="landscape"' : ""}/>`,
    margin,
    text: width - 2 * margin,
  };
}

export function buildDocx(markdown: string, opts: DocxOptions): Uint8Array {
  const look = docLook(opts.style);
  const blocks = parseBlocks(markdown);
  const links: string[] = [];
  /** Each run of numbers (a list, or a sub-list) restarts at its own number: one numbering instance each. */
  const numbered: { start: number; level: number }[] = [];
  const pg = page(look);

  /** One run; its properties in the order the schema sets. `bold`/`color` force them (table headers). */
  const run = (r: Inline, force: { bold?: boolean; color?: string } = {}): string => {
    const face = r.font ? esc(r.font) : null;
    const props =
      (r.link ? '<w:rStyle w:val="Hyperlink"/>' : r.code ? '<w:rStyle w:val="InlineCode"/>' : "") +
      (face ? `<w:rFonts w:ascii="${face}" w:hAnsi="${face}" w:cs="${face}"/>` : "") +
      (r.bold || force.bold ? "<w:b/><w:bCs/>" : "") +
      (r.italic ? "<w:i/><w:iCs/>" : "") +
      (r.strike ? "<w:strike/>" : "") +
      (r.color || force.color ? `<w:color w:val="${r.color ?? force.color}"/>` : "") +
      (r.size ? `<w:sz w:val="${Math.round(r.size * 2)}"/><w:szCs w:val="${Math.round(r.size * 2)}"/>` : "") +
      (r.underline ? '<w:u w:val="single"/>' : "") +
      (r.highlight ? `<w:shd w:val="clear" w:color="auto" w:fill="${r.highlight}"/>` : "") +
      (r.script ? `<w:vertAlign w:val="${r.script === "super" ? "superscript" : "subscript"}"/>` : "");
    return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}${textRuns(r.text)}</w:r>`;
  };
  const runs = (inlines: Inline[], force: { bold?: boolean; color?: string } = {}): string =>
    inlines
      .map((r) => {
        if (!r.link) return run(r, force);
        links.push(r.link);
        return `<w:hyperlink r:id="rIdLink${links.length}" w:history="1">${run(r, force)}</w:hyperlink>`;
      })
      .join("");
  const para = (inner: string, pPr = "") => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${inner}</w:p>`;

  // One # title at the very top reads as the document's title; several are sections.
  const h1s = blocks.filter((b) => b.type === "heading" && b.level === 1).length;
  const titleFirst = blocks[0]?.type === "heading" && blocks[0].level === 1 && h1s === 1;

  const list = (items: ListItem[]): string => {
    /** The numbering instance each level's current run of numbers uses. */
    const numAt: number[] = [];
    return items
      .map((it) => {
        let numId = 1; // bullets
        if (it.ordered) {
          if (it.start !== undefined || !numAt[it.level]) {
            numbered.push({ start: it.start ?? 1, level: it.level });
            numAt[it.level] = numbered.length + 1; // ids 2… (1 is bullets)
          }
          numId = numAt[it.level];
        }
        return para(runs(it.inlines), `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${it.level}"/><w:numId w:val="${numId}"/></w:numPr>`);
      })
      .join("");
  };

  const table = (b: Extract<Block, { type: "table" }>): string => {
    const cols = b.header.length;
    // Columns sized by their longest text, within reason.
    const len = (cells: Inline[][]) => cells.map((c) => Math.min(60, Math.max(4, c.map((r) => r.text).join("").length)));
    const weights = len(b.header);
    for (const row of b.rows) len(row).forEach((n, i) => (weights[i] = Math.max(weights[i], n)));
    const total = weights.reduce((a, n) => a + n, 0) || 1;
    const widths = weights.map((n) => Math.round((5000 * n) / total));
    const cell = (inl: Inline[], i: number, head: boolean, stripe: boolean) => {
      const fill = head ? look.tableHeader : stripe ? look.tableStripe : undefined;
      return `<w:tc><w:tcPr><w:tcW w:w="${widths[i]}" w:type="pct"/>${fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : ""}</w:tcPr>${para(
        runs(inl, head ? { bold: true, color: look.tableHeaderText } : {}),
        `<w:pStyle w:val="TableText"/>${b.align[i] && b.align[i] !== "left" ? jc(b.align[i]) : ""}`
      )}</w:tc>`;
    };
    const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="${look.tableBorder}"/>`;
    return (
      `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("")}</w:tblBorders>` +
      `<w:tblLayout w:type="autofit"/><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar>` +
      `<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr>` +
      `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${Math.round((w / 5000) * pg.text)}"/>`).join("")}</w:tblGrid>` +
      `<w:tr><w:trPr><w:tblHeader/></w:trPr>${b.header.map((h, i) => cell(h, i, true, false)).join("")}</w:tr>` +
      b.rows.map((r, ri) => `<w:tr><w:trPr><w:cantSplit/></w:trPr>${r.slice(0, cols).map((c, i) => cell(c, i, false, ri % 2 === 1)).join("")}</w:tr>`).join("") +
      `</w:tbl>` +
      // Word wants a paragraph after a table (and it spaces the next block).
      para("", '<w:spacing w:after="0"/>')
    );
  };

  // A cover page: the title (and a subtitle paragraph right after it) alone on the first page.
  const coverEnd = look.coverPage && titleFirst ? (blocks[1]?.type === "paragraph" ? 1 : 0) : -1;
  const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

  const body = blocks
    .map((b, i): string => {
      const after = i === coverEnd ? pageBreak : "";
      switch (b.type) {
        case "heading": {
          const isTitle = i === 0 && titleFirst;
          const style = isTitle ? "Title" : `Heading${Math.min(b.level - (titleFirst ? 1 : 0), 6) || 1}`;
          const cover = isTitle && look.coverPage ? '<w:spacing w:before="2880"/>' : "";
          return para(runs(b.inlines), `<w:pStyle w:val="${style}"/>${cover}${jc(b.align)}`) + after;
        }
        case "paragraph": {
          const subtitle = i === coverEnd && i === 1 ? '<w:pStyle w:val="Subtitle"/>' : "";
          return para(runs(b.inlines), `${subtitle}${jc(b.align ?? (subtitle ? look.titleAlign : undefined))}`) + after;
        }
        case "list":
          return list(b.items);
        case "code":
          return b.text
            .split("\n")
            .map((line) => para(line ? `<w:r>${textRuns(line)}</w:r>` : "", '<w:pStyle w:val="CodeBlock"/>'))
            .join("");
        case "quote":
          return b.paragraphs.map((p) => para(runs(p), '<w:pStyle w:val="Quote"/>')).join("");
        case "table":
          return table(b);
        case "rule":
          return para("", `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="${look.tableBorder}"/></w:pBdr>`);
        case "pagebreak":
          return pageBreak;
      }
    })
    .join("");

  const headerRef = look.header ? '<w:headerReference w:type="default" r:id="rIdHeader"/>' : "";
  const hasFooter = !!look.footer || look.pageNumbers;
  const footerRef = hasFooter ? '<w:footerReference w:type="default" r:id="rIdFooter"/>' : "";
  const m = pg.margin;
  const background = look.pageColor ? `<w:background w:color="${look.pageColor}"/>` : "";
  const document = `${XML_HEAD}<w:document ${W_NS}>${background}<w:body>${body || para("")}<w:sectPr>${headerRef}${footerRef}${pg.xml}<w:pgMar w:top="${m}" w:right="${m}" w:bottom="${m}" w:left="${m}" w:header="708" w:footer="708" w:gutter="0"/><w:cols w:space="708"/></w:sectPr></w:body></w:document>`;

  const small = `<w:rPr><w:color w:val="${look.subheading}"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>`;
  const headerXml = look.header
    ? `${XML_HEAD}<w:hdr ${W_NS}><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r>${small}${textRuns(look.header)}</w:r></w:p></w:hdr>`
    : null;
  const footerXml = hasFooter
    ? `${XML_HEAD}<w:ftr ${W_NS}><w:p><w:pPr><w:jc w:val="center"/></w:pPr>${look.footer ? `<w:r>${small}${textRuns(look.footer)}</w:r>` : ""}${
        look.footer && look.pageNumbers ? `<w:r>${small}<w:t xml:space="preserve">  ·  </w:t></w:r>` : ""
      }${look.pageNumbers ? `<w:fldSimple w:instr=" PAGE "><w:r>${small}<w:t>1</w:t></w:r></w:fldSimple>` : ""}</w:p></w:ftr>`
    : null;

  const date = opts.date ?? new Date();
  const overrides: Record<string, string> = {
    "/word/document.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    "/word/styles.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
    "/word/numbering.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
    "/word/settings.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml",
    "/docProps/core.xml": "application/vnd.openxmlformats-package.core-properties+xml",
    "/docProps/app.xml": "application/vnd.openxmlformats-officedocument.extended-properties+xml",
  };
  if (headerXml) overrides["/word/header1.xml"] = "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml";
  if (footerXml) overrides["/word/footer1.xml"] = "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml";
  const parts: Record<string, string> = {
    "[Content_Types].xml": contentTypes(overrides),
    "_rels/.rels": rels([
      { id: "rId1", type: "officeDocument", target: "word/document.xml" },
      { id: "rId2", type: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", target: "docProps/core.xml" },
      { id: "rId3", type: "extended-properties", target: "docProps/app.xml" },
    ]),
    "docProps/core.xml": coreProps(opts.title, date),
    "docProps/app.xml": appProps(),
    "word/document.xml": document,
    "word/_rels/document.xml.rels": rels([
      { id: "rIdStyles", type: "styles", target: "styles.xml" },
      { id: "rIdNumbering", type: "numbering", target: "numbering.xml" },
      { id: "rIdSettings", type: "settings", target: "settings.xml" },
      ...(headerXml ? [{ id: "rIdHeader", type: "header", target: "header1.xml" }] : []),
      ...(footerXml ? [{ id: "rIdFooter", type: "footer", target: "footer1.xml" }] : []),
      ...links.map((url, i) => ({ id: `rIdLink${i + 1}`, type: "hyperlink", target: url, external: true })),
    ]),
    "word/styles.xml": stylesXml(look),
    "word/numbering.xml": numberingXml(numbered, look),
    "word/settings.xml": settingsXml(!!look.pageColor),
  };
  if (headerXml) parts["word/header1.xml"] = headerXml;
  if (footerXml) parts["word/footer1.xml"] = footerXml;
  return zipParts(parts);
}

/* --------------------------------- parts ---------------------------------- */

const settingsXml = (pageColor: boolean) =>
  `${XML_HEAD}<w:settings ${W_NS}>${pageColor ? "<w:displayBackgroundShape/>" : ""}<w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

const HEADING_SCALE = [1.45, 1.18, 1.09, 1, 1, 1];

function stylesXml(look: DocLook): string {
  const f = (name: string) => `<w:rFonts w:ascii="${esc(name)}" w:hAnsi="${esc(name)}" w:eastAsia="${esc(name)}" w:cs="${esc(name)}"/>`;
  const half = (pt: number) => Math.round(pt * 2);
  const body = half(look.size);
  const line = Math.round(look.lineSpacing * 240);
  return `${XML_HEAD}<w:styles ${W_NS}>
<w:docDefaults><w:rPrDefault><w:rPr>${f(look.font)}<w:sz w:val="${body}"/><w:szCs w:val="${body}"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="${line}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/>${look.align !== "left" ? `<w:pPr>${jc(look.align)}</w:pPr>` : ""}<w:rPr><w:color w:val="${look.text}"/></w:rPr></w:style>
<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="8" w:space="6" w:color="${look.accent}"/></w:pBdr><w:spacing w:after="300" w:line="240" w:lineRule="auto"/><w:contextualSpacing/>${jc(look.titleAlign)}</w:pPr><w:rPr>${f(look.headingFont)}<w:color w:val="${look.title}"/><w:kern w:val="28"/><w:sz w:val="${half(look.size * 2.36)}"/><w:szCs w:val="${half(look.size * 2.36)}"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="11"/><w:qFormat/><w:pPr><w:spacing w:after="240"/>${jc(look.titleAlign)}</w:pPr><w:rPr><w:color w:val="${look.subheading}"/><w:sz w:val="${half(look.size * 1.27)}"/><w:szCs w:val="${half(look.size * 1.27)}"/></w:rPr></w:style>
${HEADING_SCALE.map(
  (k, i) =>
    `<w:style w:type="paragraph" w:styleId="Heading${i + 1}"><w:name w:val="heading ${i + 1}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${i === 0 ? 360 : 240}" w:after="${i === 0 ? 120 : 80}"/><w:jc w:val="left"/><w:outlineLvl w:val="${i}"/></w:pPr><w:rPr>${f(look.headingFont)}<w:b/><w:bCs/><w:color w:val="${i === 0 ? look.heading : look.subheading}"/><w:sz w:val="${half(look.size * k)}"/><w:szCs w:val="${half(look.size * k)}"/></w:rPr></w:style>`
).join("\n")}
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/><w:jc w:val="left"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="29"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="10" w:color="${look.accent}"/></w:pBdr><w:spacing w:before="120" w:after="120"/><w:ind w:left="360" w:right="360"/></w:pPr><w:rPr><w:i/><w:iCs/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:qFormat/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="144" w:right="144"/><w:jc w:val="left"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:noProof/><w:color w:val="1F2937"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:qFormat/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="left"/></w:pPr><w:rPr><w:sz w:val="${half(look.size * 0.91)}"/><w:szCs w:val="${half(look.size * 0.91)}"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:color w:val="${look.link}"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="InlineCode"><w:name w:val="Inline Code"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:qFormat/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:noProof/><w:color w:val="B91C1C"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/></w:rPr></w:style>
</w:styles>`;
}

const BULLETS = ["•", "◦", "▪"];
const NUMBER_FORMATS: [string, (n: number) => string][] = [
  ["decimal", (n) => `%${n}.`],
  ["lowerLetter", (n) => `%${n}.`],
  ["lowerRoman", (n) => `%${n}.`],
];

const levels = (lvl: (i: number) => string) => Array.from({ length: 9 }, (_, i) => lvl(i)).join("");

function numberingXml(numbered: { start: number; level: number }[], look: DocLook): string {
  const marker = `<w:rPr><w:color w:val="${look.accent}"/></w:rPr>`;
  const bullets = levels(
    (i) =>
      `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${BULLETS[i % 3]}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + 360 * i}" w:hanging="360"/></w:pPr>${marker}</w:lvl>`
  );
  const decimals = levels((i) => {
    const [fmt, text] = NUMBER_FORMATS[i % 3];
    return `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text(i + 1)}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + 360 * i}" w:hanging="360"/></w:pPr></w:lvl>`;
  });
  return `${XML_HEAD}<w:numbering ${W_NS}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${bullets}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${decimals}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>${numbered
    .map(
      (n, i) =>
        `<w:num w:numId="${i + 2}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="${n.level}"><w:startOverride w:val="${Math.max(0, n.start)}"/></w:lvlOverride></w:num>`
    )
    .join("")}</w:numbering>`;
}
