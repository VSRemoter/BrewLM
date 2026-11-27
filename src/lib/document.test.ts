// @vitest-environment jsdom
import { mkdirSync, writeFileSync } from "node:fs";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  buildDocumentPrompt,
  documentReviseContent,
  docFormatFrom,
  docFormatOf,
  documentFromReply,
  documentSummary,
  documentText,
  normalizeSheets,
  normalizeSlides,
  parseDocument,
  sheetDisplay,
  type DocSheet,
  type DocSlide,
} from "./document";
import { buildDocx, buildPptx, buildXlsx } from "./docfile";
import { evaluateBook, formulaForFile } from "./docfile/formula";
import { dateSerial, excelCode, formatDate, formatNumber, numFormat } from "./docfile/numfmt";
import { color, contrast, readable } from "./docfile/style";
import { docHtml, sheetHtml, slideHtml } from "./docfile/preview";
import { parseBlocks, parseInline } from "./docfile/mdblocks";
import { documentTitle, parseStudioCommand } from "./studioCommands";

/** Every XML part parses, and the package has what Office needs. */
function checkPackage(bytes: Uint8Array, mustHave: string[]): Record<string, string> {
  const files = unzipSync(bytes);
  const names = Object.keys(files);
  expect(names[0]).toBe("[Content_Types].xml");
  for (const m of mustHave) expect(names).toContain(m);
  const text: Record<string, string> = {};
  for (const [name, data] of Object.entries(files)) {
    const xml = strFromU8(data);
    text[name] = xml;
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    expect(doc.getElementsByTagName("parsererror").length, `${name} is well-formed`).toBe(0);
  }
  // Every part the content types name exists, and every internal relationship target too.
  const types = text["[Content_Types].xml"];
  for (const m of types.matchAll(/PartName="\/([^"]+)"/g)) expect(names).toContain(m[1]);
  for (const [name, xml] of Object.entries(text)) {
    if (!name.endsWith(".rels")) continue;
    const dir = name.replace(/_rels\/[^/]+$/, "");
    for (const m of xml.matchAll(/Target="([^"]+)"(?! TargetMode)/g)) {
      const parts = (dir + m[1]).split("/");
      const out: string[] = [];
      for (const p of parts) p === ".." ? out.pop() : p && out.push(p);
      expect(names, `${name} → ${m[1]}`).toContain(out.join("/"));
    }
  }
  return text;
}

const SAMPLE_MD = `# Car Parts Overview

An introduction to the **main systems** of a car, with *examples* and a [reference](https://example.com/cars?a=1&b=2).

## Engine

1. Pistons move up and down
2. The crankshaft turns that into rotation
   - Connected by rods
   - Balanced by weights
3. Valves let air in and exhaust out

## Comparison

| Part | Lifespan | Cost |
|:-----|:--------:|-----:|
| Brake pads | 50,000 km | $150 |
| Tires | 60,000 km | $600 |

> Regular maintenance is cheaper than repairs.

\`\`\`
check oil < every 5,000 km
\`\`\`

---

- Oil: \`5W-30\`
- ~~Leaded fuel~~ is gone`;

const SAMPLE_SLIDES: DocSlide[] = [
  { layout: "title", title: "Car Parts 101", subtitle: "What's under the hood & why it matters" },
  {
    layout: "bullets",
    title: "The engine",
    bullets: [{ text: "Turns fuel into **motion**" }, { text: "Four strokes", sub: ["Intake", "Compression", "Power", "Exhaust"] }],
    notes: "Start with the big picture.\nThen walk through the four strokes.",
  },
  { layout: "section", title: "Brakes & tires" },
  {
    layout: "two-column",
    title: "Disc vs drum brakes",
    left: { heading: "Disc", bullets: [{ text: "Better heat handling" }] },
    right: { heading: "Drum", bullets: [{ text: "Cheaper" }, { text: "Self-energizing" }] },
  },
  { layout: "table", title: "Replacement intervals", columns: ["Part", "Every"], rows: [["Oil", "5,000 km"], ["Tires", "60,000 km"]], notes: "Rough guides <only>." },
];

/** Written as a model writes it; normalized as the app stores it. */
const SAMPLE_SHEETS: DocSheet[] = normalizeSheets([
  {
    name: "Budget",
    columns: ["Item", "Qty", "Unit cost", "Total"],
    formats: ["text", "integer", "money", "money"],
    rows: [
      ["Tires", 4, 120, "=B2*C2"],
      ["Oil change", 1, 45.5, "=B3*C3"],
      ["Brake pads & rotors", 2, 80, "=B4*C4"],
      ["Total", null, null, "=SUM(D2:D4)"],
    ],
  },
  {
    name: "Summary sheet",
    columns: ["Measure", "Value"],
    formats: [null, "money"],
    rows: [
      ["Grand total", "=Budget!D5"],
      ["Average item", "=AVERAGE(Budget!D2:D4)"],
      ["Big items", "=COUNTIF(Budget!D2:D4,\">100\")"],
      ["Share of tires", "=Budget!D2/Budget!D5"],
      ["Label", '=IF(Budget!D5>500,"Over","Under") & " budget"'],
      ["Unknown fn", "=XLOOKUP(1,A2:A3,B2:B3)"],
      ["Broken", "=SUM(A1:A3"],
    ],
  },
]);

describe("markdown blocks", () => {
  it("reads headings, nested lists, tables, quotes, code and rules", () => {
    const blocks = parseBlocks(SAMPLE_MD);
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "heading", "list", "heading", "table", "quote", "code", "rule", "list"]);
    const list = blocks[3] as Extract<(typeof blocks)[number], { type: "list" }>;
    expect(list.items.map((i) => [i.level, i.ordered, i.start])).toEqual([
      [0, true, 1],
      [0, true, undefined],
      [1, false, undefined],
      [1, false, undefined],
      [0, true, undefined],
    ]);
    const table = blocks[5] as Extract<(typeof blocks)[number], { type: "table" }>;
    expect(table.align).toEqual(["left", "center", "right"]);
    expect(table.rows).toHaveLength(2);
  });

  it("styles inline text and keeps only safe links", () => {
    expect(parseInline("a **b** *c* `d` ~~e~~ [f](https://x.y) [g](javascript:void) snake_case_word")).toEqual([
      { text: "a " },
      { text: "b", bold: true },
      { text: " " },
      { text: "c", italic: true },
      { text: " " },
      { text: "d", code: true },
      { text: " " },
      { text: "e", strike: true },
      { text: " " },
      { text: "f", link: "https://x.y" },
      { text: " g snake_case_word" },
    ]);
  });
});

describe("formulas", () => {
  it("works out sums, references across sheets, text and conditions", () => {
    const shown = sheetDisplay(SAMPLE_SHEETS);
    expect(shown[0][1][3]).toBe("480.00");
    expect(shown[0][4][3]).toBe("685.50");
    expect(shown[1][1][1]).toBe("685.50");
    expect(shown[1][2][1]).toBe("228.50");
    expect(shown[1][3][1]).toBe("2.00");
    expect(shown[1][4][1]).toBe("0.70"); // money format on a fraction: shown as typed for Excel's "#,##0.00"
    expect(shown[1][5][1]).toBe("Over budget");
    expect(shown[1][6][1]).toBe("=XLOOKUP(1,A2:A3,B2:B3)"); // Excel works this one out
    expect(shown[1][7][1]).toBe("=SUM(A1:A3");
  });

  it("reports errors and loops", () => {
    const value = evaluateBook([{ name: "S", grid: [["a", "b"], [1, "=A2/0"], ["=B3", "=A3"], ["x", "=A4+1"]] }]);
    expect(value(0, 1, 1)).toEqual({ kind: "error", code: "#DIV/0!" });
    expect(value(0, 2, 0)).toEqual({ kind: "unknown" });
    expect(value(0, 3, 1)).toEqual({ kind: "error", code: "#VALUE!" });
  });

  it("writes formulas as Excel stores them, and refuses ones that don't parse", () => {
    expect(formulaForFile("=sum(A1:A3; B2)")).toBe("SUM(A1:A3,B2)");
    expect(formulaForFile("=IFS(A1>1,\"big\",TRUE,\"small\")")).toBe('_xlfn.IFS(A1>1,"big",TRUE,"small")');
    expect(formulaForFile("='My sheet'!$B$2 * 10%")).toBe("'My sheet'!$B$2*10%");
    expect(formulaForFile("=SUM(A1:A3")).toBeNull();
    expect(formulaForFile("=A1 +")).toBeNull();
  });

  it("formats numbers per column", () => {
    expect(formatNumber(0.1 + 0.2, null)).toBe("0.3");
    expect(formatNumber(1234567.891, numFormat("number"))).toBe("1,234,567.89");
    expect(formatNumber(2024, null)).toBe("2024");
    expect(formatNumber(0.256, numFormat("percent"))).toBe("25.6%");
    expect(formatNumber(-1500, numFormat("integer"))).toBe("-1,500");
  });

  it("reads currency, units and dates in any form, and always writes codes Excel takes", () => {
    const euro = numFormat({ prefix: "€", decimals: 2 });
    expect(formatNumber(-1234.5, euro)).toBe("-€1,234.50");
    expect(excelCode(euro)).toBe('"€"#,##0.00');
    const km = numFormat('#,##0.0 "km"');
    expect(formatNumber(1500, km)).toBe("1,500.0 km");
    expect(excelCode(km)).toBe('#,##0.0" km"');
    expect(excelCode(numFormat("$#,##0.00;[Red]-$#,##0.00"))).toBe('"$"#,##0.00');
    expect(excelCode(numFormat('a"b;c'))).toBeNull(); // not a number code: General, never a broken one
    const serial = dateSerial("2026-12-25")!;
    expect(serial).toBe(46381);
    expect(formatDate(serial, "mmmm d, yyyy")).toBe("December 25, 2026");
    expect(formatDate(dateSerial("2026-12-25 14:05")!, "h:mm AM/PM")).toBe("2:05 PM");
    expect(dateSerial("2026-02-30")).toBeNull();
  });
});

describe("document content", () => {
  it("names formats from everyday words", () => {
    expect(docFormatFrom("slides")).toBe("pptx");
    expect(docFormatFrom("Excel")).toBe("xlsx");
    expect(docFormatFrom(".docx")).toBe("docx");
    expect(docFormatFrom("markdown")).toBe("md");
    expect(docFormatFrom("pdf")).toBeNull();
  });

  it("takes slides leniently: fences, prose, aliases and missing layouts", () => {
    const raw = `Here you go:\n\`\`\`json\n{"slides":[{"title":"Deck"},{"type":"content","title":"Points","points":["a",{"text":"b","children":["c"]}]},{"title":"Grid","rows":[["h1","h2"],["1","2"]]},{"layout":"comparison","title":"Vs","left":["x"],"right":{"title":"R","items":["y"]}}]}\n\`\`\``;
    const d = documentFromReply("pptx", "a deck", raw);
    expect(d.slides!.map((s) => s.layout)).toEqual(["title", "bullets", "table", "two-column"]);
    expect(d.slides![1].bullets).toEqual([{ text: "a" }, { text: "b", sub: ["c"] }]);
    expect(d.slides![2].columns).toEqual(["h1", "h2"]);
    expect(d.slides![3].right).toEqual({ heading: "R", bullets: [{ text: "y" }] });
    expect(() => normalizeSlides({ slides: [] })).toThrow();
  });

  it("takes sheets leniently and makes names Excel accepts", () => {
    // (formats come back as stored formats, not the words the model used)
    const sheets = normalizeSheets({
      sheets: [
        { name: "Q1: [draft]/final", columns: [{ name: "Item", format: "text" }, { name: "Cost", format: "money" }], rows: [["A", "12"], { Item: "B", Cost: 3 }] },
        { name: "q1  draft  final", rows: [["x", "y"], ["007", true]] },
      ],
    });
    expect(sheets[0].name).toBe("Q1 draft final");
    expect(sheets[1].name).toBe("q1 draft final 2");
    expect(sheets[0].rows).toEqual([["A", 12], ["B", 3]]);
    expect(sheets[0].formats).toEqual([{ kind: "text" }, numFormat("money")]);
    // No "columns": no header row; rows start at row 1.
    expect(sheets[1].columns).toEqual([]);
    expect(sheets[1].rows).toEqual([["x", "y"], ["007", true]]);
  });

  it("round-trips through storage and reads as text", () => {
    const d = documentFromReply("xlsx", "budget", JSON.stringify({ sheets: SAMPLE_SHEETS }));
    const back = parseDocument(JSON.stringify(d))!;
    expect(back.sheets).toEqual(d.sheets);
    expect(docFormatOf(JSON.stringify(d))).toBe("xlsx");
    expect(documentSummary(back)).toBe("2 sheets · 11 rows");
    expect(back.sheets![0].formats).toEqual(d.sheets![0].formats);
    expect(documentText(back)).toContain("| Total |  |  | 685.50 |");
    const md = documentFromReply("docx", "x", "```markdown\n" + SAMPLE_MD + "\n```");
    expect(md.markdown!.startsWith("# Car Parts")).toBe(true);
    expect(documentText({ format: "pptx", prompt: "", slides: SAMPLE_SLIDES })).toContain("## Slide 2: The engine\n\n- Turns fuel into **motion**\n- Four strokes\n  - Intake");
  });

  it("reads /document with an optional file type, and needs to know what it's for", () => {
    const p = parseStudioCommand("/document slides A beginner talk on car parts");
    expect(typeof p !== "string" && p.cmd).toEqual({ tool: "document", format: "pptx", instructions: "A beginner talk on car parts", title: "Beginner talk on car parts" });
    const w = parseStudioCommand("/doc a study plan for finals");
    expect(typeof w !== "string" && w.cmd).toMatchObject({ tool: "document", format: "docx", instructions: "a study plan for finals" });
    expect(parseStudioCommand("/document excel")).toMatch(/^`\/document/);
    expect(documentTitle("the yearly running costs of a car, by month and category, with totals")).toBe("Yearly running costs of a car, by month and…");
  });

  it("asks for the format's own shape", () => {
    expect(buildDocumentPrompt("xlsx", "Budget", "car parts")).toContain('"sheets": [');
    // The request is in charge; the contract's suggestions only fill gaps.
    expect(buildDocumentPrompt("pptx", "Deck", "car parts")).toContain("The request wins on length, coverage, structure, wording and look");
    expect(buildDocumentPrompt("pptx", "Deck", "car parts")).toContain('"layout": "two-column"');
    expect(buildDocumentPrompt("docx", "Doc", "car parts")).toContain("turned into a Word file");
  });
});

const date = new Date(Date.UTC(2026, 10, 25, 12));
const out = process.env.DOCFILE_OUT;
if (out) mkdirSync(out, { recursive: true });

describe("office files", () => {
  it("writes a Word file", () => {
    const bytes = buildDocx(SAMPLE_MD, { title: "Car Parts Overview", date, style: { paper: "letter" } });
    const x = checkPackage(bytes, ["word/document.xml", "word/styles.xml", "word/numbering.xml", "word/_rels/document.xml.rels"]);
    const doc = x["word/document.xml"];
    expect(doc).toContain('<w:pStyle w:val="Title"/>');
    expect(doc).toContain('<w:pStyle w:val="Heading1"/>');
    expect(doc).toContain("<w:tbl>");
    expect(doc).toContain('w:hyperlink r:id="rIdLink1"');
    expect(x["word/_rels/document.xml.rels"]).toContain('Target="https://example.com/cars?a=1&amp;b=2" TargetMode="External"');
    // The numbered list and the sub-bullets, each with their own numbering.
    expect(x["word/numbering.xml"]).toContain('<w:num w:numId="2"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/>');
    if (out) writeFileSync(`${out}/sample.docx`, bytes);
  });

  it("writes a PowerPoint file", () => {
    const bytes = buildPptx(SAMPLE_SLIDES, { title: "Car Parts 101", date });
    const x = checkPackage(bytes, ["ppt/presentation.xml", "ppt/slides/slide5.xml", "ppt/notesSlides/notesSlide2.xml", "ppt/theme/theme1.xml"]);
    expect(x["ppt/presentation.xml"].match(/<p:sldId /g)).toHaveLength(5);
    expect(x["ppt/slides/slide2.xml"]).toContain('<a:rPr lang="en-US" sz="2000" b="1" dirty="0">');
    expect(x["ppt/slides/slide5.xml"]).toContain("<a:tbl>");
    expect(x["ppt/notesSlides/notesSlide5.xml"]).toContain("Rough guides &lt;only&gt;.");
    expect(Object.keys(x)).not.toContain("ppt/notesSlides/notesSlide1.xml");
    if (out) writeFileSync(`${out}/sample.pptx`, bytes);
  });

  it("writes an Excel file with cached formula values", () => {
    const bytes = buildXlsx(SAMPLE_SHEETS, { title: "Budget", date });
    const x = checkPackage(bytes, ["xl/workbook.xml", "xl/worksheets/sheet2.xml", "xl/sharedStrings.xml", "xl/styles.xml"]);
    const s1 = x["xl/worksheets/sheet1.xml"];
    expect(s1).toMatch(/<c r="D5" s="\d+"><f>SUM\(D2:D4\)<\/f><v>685.5<\/v><\/c>/);
    expect(s1).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    const s2 = x["xl/worksheets/sheet2.xml"];
    expect(s2).toContain("<f>Budget!D5</f><v>685.5</v>");
    expect(s2).toContain('t="str"><f>IF(Budget!D5&gt;500,&quot;Over&quot;,&quot;Under&quot;)&amp;&quot; budget&quot;</f><v>Over budget</v>');
    expect(s2).toContain("<f>_xlfn.XLOOKUP(1,A2:A3,B2:B3)</f></c>");
    // The broken formula is text, not a formula.
    expect(s2).not.toContain("<f>SUM(A1:A3</f>");
    expect(x["xl/sharedStrings.xml"]).toContain("=SUM(A1:A3");
    expect(x["xl/workbook.xml"]).toContain('<sheet name="Summary sheet" sheetId="2" r:id="rId2"/>');
    if (out) writeFileSync(`${out}/sample.xlsx`, bytes);
  });
});

describe("the look a request asks for", () => {
  it("reads colors in any common form, and keeps text readable", () => {
    expect(color("#c00")).toBe("CC0000");
    expect(color("rgb(0, 128, 0)")).toBe("008000");
    expect(color("Forest Green")).toBe("228B22");
    expect(color("url(javascript:x)")).toBeUndefined();
    expect(readable("FFFFFF", "FFFFFF")).toBe("111827"); // white on white becomes dark
    expect(contrast(readable("111827", "0F172A"), "0F172A")).toBeGreaterThan(3);
  });

  it("takes a deck theme, slide overrides, new layouts and free elements", () => {
    const d = documentFromReply(
      "pptx",
      "Christmas sleep talk",
      JSON.stringify({
        theme: { background: "#FFF8F0", text: "#14532D", title: "#B91C1C", accent: "red", coverBackground: { from: "#B91C1C", to: "#14532D", angle: 45 }, headingFont: "Georgia; color:red", decoration: "band", textScale: 9 },
        slides: [
          { layout: "title", title: "Why sleep matters", subtitle: "Merry rest" },
          { layout: "quote", quote: "Sleep is the best meditation.", attribution: "Dalai Lama" },
          { layout: "stat", title: "By the numbers", stats: [{ value: "8 h", label: "a night" }, { value: "1 in 3", label: "short on sleep" }] },
          { title: "Snow", elements: [{ type: "shape", shape: "star", x: 80, y: 5, w: 10, h: 15, fill: "#FACC15" }, { type: "text", x: 10, y: 70, w: 50, h: 10, text: "Ho ho ho", color: "#B91C1C", size: 28 }] },
        ],
      })
    );
    expect(d.theme).toEqual({
      background: "FFF8F0",
      text: "14532D",
      title: "B91C1C",
      accent: "DC2626",
      coverBackground: { from: "B91C1C", to: "14532D", angle: 45 },
      headingFont: "Georgia",
      decoration: "band",
      textScale: 1.5,
    });
    expect(d.slides!.map((x) => x.layout)).toEqual(["title", "quote", "stat", "blank"]);
    expect(d.slides![3].elements![0]).toMatchObject({ type: "shape", shape: "star", fill: "FACC15" });
    // The preview draws the theme, and escapes what the model wrote.
    const html = slideHtml({ layout: "bullets", title: "<script>x</script>", bullets: [{ text: "**hi**" }] }, 2, d.theme);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<b>hi</b>");
    expect(html).toContain("#FFF8F0");
    expect(slideHtml(d.slides![0], 1, d.theme)).toContain("linear-gradient(135deg, #B91C1C, #14532D)");
  });

  it("writes the theme into the deck: colors, fonts, gradients, decorative shapes", () => {
    const d = documentFromReply(
      "pptx",
      "x",
      JSON.stringify({
        theme: { coverBackground: { from: "#B91C1C", to: "#14532D" }, headingFont: "Georgia", accent: "#B91C1C" },
        slides: [
          { layout: "title", title: "Hi" },
          { layout: "bullets", title: "Points", bullets: ["a"], elements: [{ type: "shape", shape: "heart", x: 1, y: 1, w: 5, h: 5, fill: "#ff0000", opacity: 0.5 }] },
          { layout: "quote", quote: "Q", attribution: "A" },
          { layout: "stat", title: "S", stats: [{ value: "1", label: "one" }] },
          { layout: "blank", elements: [{ type: "text", x: 0, y: 0, w: 50, h: 50, text: "Only me" }] },
        ],
      })
    );
    const x = checkPackage(buildPptx(d.slides!, { title: "x", theme: d.theme }), ["ppt/slideLayouts/slideLayout6.xml"]);
    expect(x["ppt/slides/slide1.xml"]).toContain('<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="B91C1C"/>');
    expect(x["ppt/slides/slide1.xml"]).toContain('<a:latin typeface="Georgia"/>');
    expect(x["ppt/slides/slide2.xml"]).toContain('<a:prstGeom prst="heart">');
    expect(x["ppt/slides/slide2.xml"]).toContain('<a:alpha val="50000"/>');
    expect(x["ppt/theme/theme1.xml"]).toContain('<a:majorFont><a:latin typeface="Georgia"/>');
    expect(x["ppt/slides/_rels/slide5.xml.rels"]).toContain("slideLayout6.xml");
    // Shapes without words are marked decorative; text boxes aren't.
    expect(x["ppt/slides/slide2.xml"]).toMatch(/name="Shape 100"><a:extLst>/);
    expect(x["ppt/slides/slide5.xml"]).toMatch(/name="TextBox 100"\/>/);
    if (out) writeFileSync(`${out}/themed.pptx`, buildPptx(d.slides!, { title: "Themed", theme: d.theme }));
  });

  it("reads a Word style block, inline styling, alignment and page breaks", () => {
    const md = `\`\`\`style
{"font": "Georgia", "heading": "#B91C1C", "subheading": "#15803D", "pageColor": "#FFFDF7", "orientation": "landscape", "header": "Sleep & you", "pageNumbers": true, "coverPage": true, "tableHeader": "#B91C1C"}
\`\`\`

# Why Sleep Matters

A festive guide.

## Rest

<p align="center">Centered <span style="color:#16a34a; font-size:14pt">green</span> <mark>marked</mark> H<sub>2</sub>O and x<sup>2</sup> <u>under</u></p>

<!-- pagebreak -->

| A | B |
|---|---|
| 1 | 2 |`;
    const d = documentFromReply("docx", "x", md);
    expect(d.style).toMatchObject({ font: "Georgia", heading: "B91C1C", orientation: "landscape", coverPage: true });
    expect(d.markdown!.startsWith("# Why Sleep Matters")).toBe(true);
    const blocks = parseBlocks(d.markdown!);
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "heading", "paragraph", "pagebreak", "table"]);
    const p = blocks[3] as Extract<(typeof blocks)[number], { type: "paragraph" }>;
    expect(p.align).toBe("center");
    expect(p.inlines).toEqual(
      expect.arrayContaining([
        { text: "green", color: "16A34A", size: 14 },
        { text: "marked", highlight: "FFF59D" },
        { text: "2", script: "sub" },
        { text: "under", underline: true },
      ])
    );
    const x = checkPackage(buildDocx(d.markdown!, { title: "x", date, style: d.style }), ["word/header1.xml", "word/footer1.xml"]);
    const doc = x["word/document.xml"];
    expect(doc).toContain('<w:background w:color="FFFDF7"/>');
    expect(doc).toContain('w:orient="landscape"');
    expect(doc).toContain('<w:br w:type="page"/>');
    expect(doc).toContain('<w:pStyle w:val="Subtitle"/>');
    expect(doc).toContain('<w:jc w:val="center"/>');
    expect(doc).toContain('<w:color w:val="16A34A"/><w:sz w:val="28"/>');
    expect(doc).toContain('<w:vertAlign w:val="subscript"/>');
    expect(x["word/footer1.xml"]).toContain('w:instr=" PAGE "');
    expect(x["word/styles.xml"]).toContain('<w:rFonts w:ascii="Georgia"');
    expect(x["word/settings.xml"]).toContain("<w:displayBackgroundShape/>");
    expect(docHtml(d.markdown!, d.style)).toContain("background:#FFFDF7");
    if (out) writeFileSync(`${out}/styled.docx`, buildDocx(d.markdown!, { title: "Styled", date, style: d.style }));
  });

  it("styles sheets: ranges, merges, title rows, dates, custom formats, tab colors", () => {
    const d = documentFromReply(
      "xlsx",
      "x",
      JSON.stringify({
        style: { headerFill: "#B91C1C", stripe: "#FEF2F2", font: "Georgia" },
        sheets: [
          {
            name: "Gifts",
            tabColor: "#16A34A",
            rows: [
              ["Christmas gift budget", "", ""],
              ["Gift", "When", "Cost"],
              ["Book", "2026-12-20", 25],
              ["Scarf", "2026-12-22", 40],
              [{ v: "Total", bold: true }, "", "=SUM(C3:C4)"],
            ],
            formats: [null, "mmm d, yyyy", { prefix: "€", decimals: 2 }],
            merge: ["A1:C1"],
            styles: { A1: { size: 18, bold: true, color: "#B91C1C", align: "center" }, "A2:C2": { bold: true, fill: "#14532D", color: "#FFFFFF" } },
            widths: [30],
          },
        ],
      })
    );
    const sh = d.sheets![0];
    expect(sh.columns).toEqual([]);
    expect(sh.rows[2][1]).toBe(dateSerial("2026-12-20")); // a real date
    expect(sh.styles!.A5).toEqual({ bold: true });
    expect(sh.styles!.B2).toMatchObject({ fill: "14532D" });
    const shown = sheetDisplay(d.sheets!);
    expect(shown[0][2]).toEqual(["Book", "Dec 20, 2026", "€25.00"]);
    expect(shown[0][4][2]).toBe("€65.00");
    const x = checkPackage(buildXlsx(d.sheets!, { title: "x", style: d.sheetStyle }), ["xl/styles.xml"]);
    const s1 = x["xl/worksheets/sheet1.xml"];
    expect(s1).toContain('<sheetPr><tabColor rgb="FF16A34A"/></sheetPr>');
    expect(s1).toContain('<mergeCell ref="A1:C1"/>');
    expect(s1).toContain('<col min="1" max="1" width="30" customWidth="1"/>');
    expect(s1).not.toContain("<pane"); // no header row to freeze
    expect(x["xl/styles.xml"]).toContain('formatCode="mmm d, yyyy"');
    expect(x["xl/styles.xml"]).toContain('formatCode="&quot;€&quot;#,##0.00"');
    expect(x["xl/styles.xml"]).toContain('<name val="Georgia"/>');
    expect(sheetHtml(sh, shown[0], d.sheetStyle)).toContain('colspan="3"');
    // What a revision sees: dates as dates, formats in the prompt's words.
    expect(documentReviseContent(d)).toContain('"2026-12-20"');
    expect(documentReviseContent(d)).toContain('{"prefix":"€","decimals":2}');
    if (out) writeFileSync(`${out}/styled.xlsx`, buildXlsx(d.sheets!, { title: "Styled", style: d.sheetStyle }));
  });
});
