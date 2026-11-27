/**
 * Sheets → an Excel file (.xlsx), in the look the request asked for: fonts,
 * header colors, striped rows, borders, per-cell and per-range styles,
 * merged cells, column widths and alignment, tab colors, number formats and
 * real dates. Formulas stay live and carry their worked-out values (so
 * previews that don't calculate still show numbers; Excel recalculates on
 * open anyway). Every style is pooled into the workbook's style table, so a
 * thousand bold cells share one entry.
 */
import { a1Name, cellFormat, sheetGrid, type CellStyle, type DocSheet, type SheetStyle } from "../document";
import { colName, evaluateBook, formulaForFile, isFormula, showComputed } from "./formula";
import { sheetLook, type SheetLook } from "./look";
import { excelCode, type NumFormat } from "./numfmt";
import { readable, type Hex } from "./style";
import { appProps, contentTypes, coreProps, esc, rels, XML_HEAD, zipParts } from "./xml";

const MAIN_NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** Everything that decides one cell's look, resolved. */
interface XfSpec {
  font: { name: string; size: number; bold: boolean; italic: boolean; underline: boolean; color: Hex };
  fill?: Hex;
  border?: Hex;
  /** Only the header row's bottom edge. */
  headerRule?: Hex;
  numFmt: string | null;
  align?: string;
  valign?: string;
  wrap: boolean;
}

/** The workbook's style table: fonts, fills, borders and formats, each pooled. */
class StyleBook {
  private fonts: string[] = [];
  private fills: string[] = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  private borders: string[] = ["<border><left/><right/><top/><bottom/><diagonal/></border>"];
  private fmts: string[] = [];
  private xfs: string[] = [];
  private xfIndex = new Map<string, number>();

  constructor(base: XfSpec) {
    this.xf(base); // style 0: the workbook's plain cell
  }

  private pool(list: string[], xml: string, offset = 0): number {
    const i = list.indexOf(xml);
    if (i >= 0) return i + offset;
    list.push(xml);
    return list.length - 1 + offset;
  }

  xf(s: XfSpec): number {
    const fontXml = `<font>${s.font.bold ? "<b/>" : ""}${s.font.italic ? "<i/>" : ""}${s.font.underline ? "<u/>" : ""}<sz val="${s.font.size}"/><color rgb="FF${s.font.color}"/><name val="${esc(s.font.name)}"/><family val="2"/></font>`;
    const fontId = this.pool(this.fonts, fontXml);
    const fillId = s.fill ? this.pool(this.fills, `<fill><patternFill patternType="solid"><fgColor rgb="FF${s.fill}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const side = (tag: string, c?: Hex) => (c ? `<${tag} style="thin"><color rgb="FF${c}"/></${tag}>` : `<${tag}/>`);
    const borderXml = s.border
      ? `<border>${side("left", s.border)}${side("right", s.border)}${side("top", s.border)}${side("bottom", s.headerRule ?? s.border)}<diagonal/></border>`
      : s.headerRule
        ? `<border><left/><right/><top/>${side("bottom", s.headerRule)}<diagonal/></border>`
        : this.borders[0];
    const borderId = this.pool(this.borders, borderXml);
    const numFmtId = s.numFmt === null ? 0 : s.numFmt === "@" ? 49 : this.pool(this.fmts, s.numFmt, 164);
    const alignment =
      s.align || s.valign || s.wrap
        ? `<alignment${s.align ? ` horizontal="${s.align}"` : ""}${s.valign ? ` vertical="${s.valign}"` : ""}${s.wrap ? ' wrapText="1"' : ""}/>`
        : "";
    const attrs = `numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"${numFmtId ? ' applyNumberFormat="1"' : ""}${fontId ? ' applyFont="1"' : ""}${fillId ? ' applyFill="1"' : ""}${borderId ? ' applyBorder="1"' : ""}`;
    const xml = alignment ? `<xf ${attrs} applyAlignment="1">${alignment}</xf>` : `<xf ${attrs}/>`;
    let i = this.xfIndex.get(xml);
    if (i === undefined) {
      i = this.xfs.length;
      this.xfs.push(xml);
      this.xfIndex.set(xml, i);
    }
    return i;
  }

  xml(): string {
    const numFmts = this.fmts.length
      ? `<numFmts count="${this.fmts.length}">${this.fmts.map((code, i) => `<numFmt numFmtId="${164 + i}" formatCode="${esc(code)}"/>`).join("")}</numFmts>`
      : "";
    return `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${numFmts}<fonts count="${this.fonts.length}">${this.fonts.join("")}</fonts><fills count="${this.fills.length}">${this.fills.join("")}</fills><borders count="${this.borders.length}">${this.borders.join("")}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${this.xfs.length}">${this.xfs.join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>`;
  }
}

const H_ALIGN: Record<string, string> = { left: "left", center: "center", right: "right" };
const V_ALIGN: Record<string, string> = { top: "top", middle: "center", bottom: "bottom" };

/** One cell's resolved look: the sheet's, its row's role, its column's, then its own. */
function cellSpec(sh: DocSheet, look: SheetLook, r: number, c: number, text: string): XfSpec {
  const header = sh.columns.length > 0 && r === 0;
  const own: CellStyle = sh.styles?.[a1Name(r, c)] ?? {};
  const dataRow = r - (sh.columns.length ? 1 : 0);
  const fill = own.fill ?? (header ? look.headerFill : look.stripe && dataRow % 2 === 1 ? look.stripe : undefined);
  const baseColor = header ? look.headerText : "111827";
  const color = own.color ?? (fill ? readable(baseColor, fill, 3) : baseColor);
  const format: NumFormat | null = cellFormat(sh, r, c);
  const colAlign = header ? undefined : (sh.align?.[c] ?? undefined);
  const wrap = own.wrap ?? (header || text.length > 60 || text.includes("\n"));
  return {
    font: {
      name: own.font ?? look.font,
      size: own.size ?? look.size,
      bold: own.bold ?? (header && look.headerBold),
      italic: own.italic ?? false,
      underline: own.underline ?? false,
      color,
    },
    fill,
    border: own.border ?? look.border,
    headerRule: header && !look.border ? "94A3B8" : undefined,
    numFmt: excelCode(format),
    align: H_ALIGN[own.align ?? colAlign ?? ""],
    valign: V_ALIGN[own.valign ?? (header ? "middle" : wrap ? "top" : "")],
    wrap,
  };
}

export function buildXlsx(sheets: DocSheet[], opts: { title: string; date?: Date; style?: SheetStyle }): Uint8Array {
  const value = evaluateBook(sheets.map((sh) => ({ name: sh.name, grid: sheetGrid(sh) })));
  const plain = sheetLook(opts.style);
  const book = new StyleBook({
    font: { name: plain.font, size: plain.size, bold: false, italic: false, underline: false, color: "111827" },
    numFmt: null,
    wrap: false,
  });
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  const shared = (s: string) => {
    let i = stringIndex.get(s);
    if (i === undefined) {
      i = strings.length;
      strings.push(s);
      stringIndex.set(s, i);
    }
    return i;
  };

  const sheetXml = sheets.map((sh, s) => {
    const look = sheetLook(opts.style, sh.style);
    const grid = sheetGrid(sh);
    const width = Math.max(1, ...grid.map((r) => r.length));
    const shown = grid.map((row, r) =>
      row.map((cell, c) =>
        typeof cell === "string" && isFormula(cell)
          ? showComputed(value(s, r, c), cellFormat(sh, r, c))
          : showComputed(cell === null ? { kind: "blank" } : { kind: "value", value: cell }, cellFormat(sh, r, c))
      )
    );
    // The first cell of each merge across columns: its text spans them, so it doesn't widen its own.
    const mergeStarts = new Set((sh.merge ?? []).filter((m) => m.split(":")[0].replace(/\d+/, "") !== m.split(":")[1].replace(/\d+/, "")).map((m) => m.split(":")[0]));
    // Column widths: the request's, else the longest thing shown, within reason.
    const widths = Array.from({ length: width }, (_, c) => {
      const asked = sh.widths?.[c];
      if (asked) return asked;
      let longest = 0;
      for (let r = 0; r < Math.min(shown.length, 500); r++) {
        if (mergeStarts.has(a1Name(r, c))) continue;
        longest = Math.max(longest, ...(shown[r][c] ?? "").split("\n").map((l) => l.length));
      }
      return Math.min(60, Math.max(8, Math.ceil(longest * 1.15) + 2));
    });
    const rows = grid
      .map((row, r) => {
        let tallest = 0;
        const cells = Array.from({ length: width }, (_, c) => {
          const cell = row[c] ?? null;
          const ref = `${colName(c)}${r + 1}`;
          const text = shown[r]?.[c] ?? "";
          const spec = cellSpec(sh, look, r, c, text);
          tallest = Math.max(tallest, spec.font.size);
          const st = book.xf(spec);
          const sAttr = st ? ` s="${st}"` : "";
          if (cell === null) return st ? `<c r="${ref}"${sAttr}/>` : "";
          if (typeof cell === "number") return `<c r="${ref}"${sAttr}><v>${cell}</v></c>`;
          if (typeof cell === "boolean") return `<c r="${ref}"${sAttr} t="b"><v>${cell ? 1 : 0}</v></c>`;
          if (isFormula(cell)) {
            const f = formulaForFile(cell);
            if (f !== null) {
              const v = value(s, r, c);
              const fx = `<f>${esc(f)}</f>`;
              if (v.kind === "value") {
                if (typeof v.value === "number") return `<c r="${ref}"${sAttr}>${fx}<v>${v.value}</v></c>`;
                if (typeof v.value === "boolean") return `<c r="${ref}"${sAttr} t="b">${fx}<v>${v.value ? 1 : 0}</v></c>`;
                return `<c r="${ref}"${sAttr} t="str">${fx}<v>${esc(v.value)}</v></c>`;
              }
              if (v.kind === "error") return `<c r="${ref}"${sAttr} t="e">${fx}<v>${esc(v.code)}</v></c>`;
              return `<c r="${ref}"${sAttr}>${fx}</c>`;
            }
            // Doesn't parse: kept as the text it is, or Excel would call the file damaged.
          }
          return `<c r="${ref}"${sAttr} t="s"><v>${shared(String(cell))}</v></c>`;
        }).join("");
        // Rows with bigger text get taller.
        const ht = tallest > 13 ? ` ht="${Math.round(tallest * 1.45)}" customHeight="1"` : "";
        return `<row r="${r + 1}"${ht}>${cells}</row>`;
      })
      .join("");
    const last = `${colName(width - 1)}${Math.max(1, grid.length)}`;
    const freeze = look.freeze && sh.columns.length > 0;
    const view = `<sheetView workbookViewId="0"${s === 0 ? ' tabSelected="1"' : ""}${look.gridlines ? "" : ' showGridLines="0"'}>${
      freeze ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' : ""
    }</sheetView>`;
    const sheetPr = look.tabColor ? `<sheetPr><tabColor rgb="FF${look.tabColor}"/></sheetPr>` : "";
    const merges = sh.merge?.length ? `<mergeCells count="${sh.merge.length}">${sh.merge.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "";
    return `${XML_HEAD}<worksheet ${MAIN_NS}>${sheetPr}<dimension ref="A1:${last}"/><sheetViews>${view}</sheetViews><sheetFormatPr defaultRowHeight="${Math.round(look.size * 1.36)}"/><cols>${widths
      .map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`)
      .join("")}</cols><sheetData>${rows}</sheetData>${merges}<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
  });

  const workbook = `${XML_HEAD}<workbook ${MAIN_NS}><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="17000"/></bookViews><sheets>${sheets
    .map((sh, i) => `<sheet name="${esc(sh.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("")}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;

  const sst = `${XML_HEAD}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings
    .map((t) => `<si><t xml:space="preserve">${esc(t)}</t></si>`)
    .join("")}</sst>`;

  const overrides: Record<string, string> = {
    "/xl/workbook.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    "/xl/styles.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
    "/xl/sharedStrings.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml",
    "/docProps/core.xml": "application/vnd.openxmlformats-package.core-properties+xml",
    "/docProps/app.xml": "application/vnd.openxmlformats-officedocument.extended-properties+xml",
  };
  sheets.forEach((_, i) => (overrides[`/xl/worksheets/sheet${i + 1}.xml`] = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"));

  const parts: Record<string, string> = {
    "[Content_Types].xml": contentTypes(overrides),
    "_rels/.rels": rels([
      { id: "rId1", type: "officeDocument", target: "xl/workbook.xml" },
      { id: "rId2", type: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", target: "docProps/core.xml" },
      { id: "rId3", type: "extended-properties", target: "docProps/app.xml" },
    ]),
    "docProps/core.xml": coreProps(opts.title, opts.date ?? new Date()),
    "docProps/app.xml": appProps(),
    "xl/workbook.xml": workbook,
    "xl/_rels/workbook.xml.rels": rels([
      ...sheets.map((_, i) => ({ id: `rId${i + 1}`, type: "worksheet", target: `worksheets/sheet${i + 1}.xml` })),
      { id: `rId${sheets.length + 1}`, type: "styles", target: "styles.xml" },
      { id: `rId${sheets.length + 2}`, type: "sharedStrings", target: "sharedStrings.xml" },
    ]),
    "xl/sharedStrings.xml": sst,
  };
  sheetXml.forEach((x, i) => (parts[`xl/worksheets/sheet${i + 1}.xml`] = x));
  // Styles last: the sheets above added every look they use to the book.
  parts["xl/styles.xml"] = book.xml();
  return zipParts(parts);
}
