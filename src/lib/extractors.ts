/**
 * Format-specific text extraction for everything that isn't a PDF, image, or
 * audio file. One dispatcher (`extractFileText`) routes by extension, parses
 * office/eBook formats from their zipped XML, cleans markup formats (RTF,
 * HTML), handles non-UTF-8 plain text — and REJECTS binary formats it can't
 * read, so unusable bytes are never stored as a source. Extraction failures
 * throw user-friendly errors; the ingest layer surfaces them in the UI.
 */

import { unzipSync } from "fflate";

/**
 * Sanity guard only (~2,500 pages). Chat never sends a whole source — it
 * retrieves the relevant chunks — so full books are stored and searchable
 * end-to-end; embedding even this much costs about a cent.
 */
export const MAX_SOURCE_CHARS = 5_000_000;
const MAX_EXTRACT_CHARS = MAX_SOURCE_CHARS;
const TRUNCATED_NOTE = "\n\n[Truncated — the file is too large to embed in full.]";

export interface ExtractedText {
  text: string;
  /** Non-fatal caveat worth surfacing (e.g. image-only deck). */
  warning?: string;
}

/* ------------------------------ shared helpers ----------------------------- */

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, "application/xml");
}

/** Concatenate the text of every <t> run (any namespace) inside el. */
function runsText(el: Element): string {
  return Array.from(el.getElementsByTagNameNS("*", "t"))
    .map((t) => t.textContent ?? "")
    .join("");
}

/** One string per <p> paragraph element (any namespace), blanks dropped. */
function paragraphLines(doc: Document): string[] {
  const out: string[] = [];
  for (const p of Array.from(doc.getElementsByTagNameNS("*", "p"))) {
    const line = runsText(p).trim();
    if (line) out.push(line);
  }
  return out;
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

function cap(text: string): string {
  return text.length > MAX_EXTRACT_CHARS ? text.slice(0, MAX_EXTRACT_CHARS) + TRUNCATED_NOTE : text;
}

/* --------------------------------- OOXML ---------------------------------- */

/** .pptx — slides live at ppt/slides/slideN.xml, text in <a:t> runs. */
function extractPptxText(bytes: Uint8Array): string {
  const entries = unzipSync(bytes);
  const decoder = new TextDecoder();
  const slides: { num: number; xml: string }[] = [];
  for (const name of Object.keys(entries)) {
    const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
    if (m) slides.push({ num: Number(m[1]), xml: decoder.decode(entries[name]) });
  }
  slides.sort((a, b) => a.num - b.num);
  const parts: string[] = [];
  for (const slide of slides) {
    const paras = paragraphLines(parseXml(slide.xml));
    if (paras.length) parts.push(`[Slide ${slide.num}]\n${paras.join("\n")}`);
  }
  return cap(parts.join("\n\n"));
}

/** .docx — body text lives at word/document.xml in <w:p>/<w:t>. Table cells
 * are paragraphs too, so tabular content comes along for free. */
function extractDocxText(bytes: Uint8Array): string {
  const entries = unzipSync(bytes);
  if (!entries["word/document.xml"]) throw new Error("missing word/document.xml");
  const doc = parseXml(new TextDecoder().decode(entries["word/document.xml"]));
  return cap(paragraphLines(doc).join("\n"));
}

/** .xlsx — cells hold either inline text or an index into the shared-strings
 * table; sheet names come from workbook.xml joined through its .rels. */
function extractXlsxText(bytes: Uint8Array): string {
  const entries = unzipSync(bytes);
  const decode = (name: string) => new TextDecoder().decode(entries[name]);

  const shared: string[] = [];
  if (entries["xl/sharedStrings.xml"]) {
    const doc = parseXml(decode("xl/sharedStrings.xml"));
    for (const si of Array.from(doc.getElementsByTagNameNS("*", "si"))) {
      shared.push(runsText(si));
    }
  }

  // workbook.xml.rels maps rId → worksheet part; workbook.xml gives the order.
  const relTarget = new Map<string, string>();
  if (entries["xl/_rels/workbook.xml.rels"]) {
    const doc = parseXml(decode("xl/_rels/workbook.xml.rels"));
    for (const rel of Array.from(doc.getElementsByTagNameNS("*", "Relationship"))) {
      const id = rel.getAttribute("Id");
      const target = rel.getAttribute("Target");
      if (id && target) relTarget.set(id, target);
    }
  }
  const sheets: { name: string; path: string; num: number }[] = [];
  if (entries["xl/workbook.xml"]) {
    const doc = parseXml(decode("xl/workbook.xml"));
    let n = 0;
    for (const sheet of Array.from(doc.getElementsByTagNameNS("*", "sheet"))) {
      const rid = sheet.getAttribute("r:id");
      const target = rid ? relTarget.get(rid) : undefined;
      if (!target) continue;
      sheets.push({
        name: sheet.getAttribute("name") ?? `Sheet ${++n}`,
        path: target.startsWith("/") ? target.slice(1) : `xl/${target}`,
        num: ++n,
      });
    }
  }
  if (!sheets.length) {
    for (const name of Object.keys(entries)) {
      const m = /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(name);
      if (m) sheets.push({ name: `Sheet ${m[1]}`, path: name, num: Number(m[1]) });
    }
    sheets.sort((a, b) => a.num - b.num);
  }

  const parts: string[] = [];
  let total = 0;
  let truncated = false;
  for (const sheet of sheets) {
    if (!entries[sheet.path] || truncated) continue;
    const doc = parseXml(decode(sheet.path));
    const rows: string[] = [];
    for (const row of Array.from(doc.getElementsByTagNameNS("*", "row"))) {
      const cells = Array.from(row.getElementsByTagNameNS("*", "c")).map((c) => {
        const t = c.getAttribute("t");
        if (t === "inlineStr") return runsText(c).trim();
        const v = c.getElementsByTagNameNS("*", "v")[0]?.textContent ?? "";
        return (t === "s" ? shared[Number(v)] ?? "" : v).trim();
      });
      const line = cells.join(" | ").replace(/(\s*\|\s*)+$/, "").trim();
      if (line) rows.push(line);
      total += line.length;
      if (total > MAX_EXTRACT_CHARS) {
        truncated = true;
        break;
      }
    }
    if (rows.length) parts.push(`[Sheet: ${sheet.name}]\n${rows.join("\n")}`);
  }
  const out = parts.join("\n\n");
  return truncated ? out + TRUNCATED_NOTE : out;
}

/* --------------------------------- ePub ----------------------------------- */

/** .epub — a zip whose OPF manifest lists chapter documents in spine order. */
function extractEpubText(bytes: Uint8Array): string {
  const entries = unzipSync(bytes);
  const decode = (name: string) => new TextDecoder().decode(entries[name]);
  if (!entries["META-INF/container.xml"]) throw new Error("missing META-INF/container.xml");
  const container = parseXml(decode("META-INF/container.xml"));
  const rootfile =
    container.getElementsByTagNameNS("*", "rootfile")[0]?.getAttribute("full-path") ?? "";
  if (!rootfile || !entries[rootfile]) throw new Error("missing OPF package document");

  const opf = parseXml(decode(rootfile));
  const opfDir = rootfile.includes("/") ? rootfile.slice(0, rootfile.lastIndexOf("/") + 1) : "";
  const manifest = new Map<string, string>();
  for (const item of Array.from(opf.getElementsByTagNameNS("*", "item"))) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    const mediaType = item.getAttribute("media-type") ?? "";
    if (id && href && mediaType.includes("html")) manifest.set(id, href);
  }

  const parts: string[] = [];
  let total = 0;
  let chapter = 0;
  let truncated = false;
  for (const ref of Array.from(opf.getElementsByTagNameNS("*", "itemref"))) {
    const href = manifest.get(ref.getAttribute("idref") ?? "");
    if (!href) continue;
    const path = entries[opfDir + href] ? opfDir + href : opfDir + decodeURIComponent(href);
    if (!entries[path]) continue;
    const doc = new DOMParser().parseFromString(decode(path), "text/html");
    doc.querySelectorAll("script,style,noscript,svg").forEach((el) => el.remove());
    const text = collapseWhitespace(doc.body?.textContent ?? "");
    if (!text) continue;
    chapter++;
    parts.push(`[Chapter ${chapter}]\n${text}`);
    total += text.length;
    if (total > MAX_EXTRACT_CHARS) {
      truncated = true;
      break;
    }
  }
  const out = parts.join("\n\n");
  return truncated ? out + TRUNCATED_NOTE : out;
}

/* ---------------------------------- RTF ------------------------------------ */

// Bytes 0x80–0x9F differ between Latin-1 and Windows-1252; RTF \'xx escapes
// use the document's ANSI code page, almost always cp1252.
const CP1252_HIGH: Record<number, string> = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡",
  0x88: "ˆ", 0x89: "‰", 0x8a: "Š", 0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž",
  0x91: "\u2018", 0x92: "\u2019", 0x93: "\u201c", 0x94: "\u201d", 0x95: "•",
  0x96: "–", 0x97: "—", 0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ",
  0x9e: "ž", 0x9f: "Ÿ",
};

function cp1252(byte: number): string {
  return CP1252_HIGH[byte] ?? String.fromCharCode(byte);
}

/** Groups whose contents are metadata/embedded objects, not document text. */
const RTF_DESTINATIONS = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "datastore",
  "themedata", "colorschememapping", "filetbl", "listtable", "revtbl",
  "xmlnstbl", "comment", "annotation", "header", "footer", "footnote",
  "xe", "tc", "shp", "nonesttables",
]);

/** Minimal RTF → plain text: skips destination groups, decodes \'xx and \uN
 * escapes, keeps paragraph/tab structure. Formatting is discarded on purpose. */
export function rtfToPlainText(rtf: string): string {
  let out = "";
  const stack: { skip: boolean; ucSkip: number }[] = [];
  let skip = false;
  let ucSkip = 1;
  let i = 0;
  while (i < rtf.length) {
    const ch = rtf[i];
    if (ch === "{") {
      stack.push({ skip, ucSkip });
      i++;
    } else if (ch === "}") {
      const prev = stack.pop();
      if (prev) ({ skip, ucSkip } = prev);
      i++;
    } else if (ch === "\\") {
      const wordMatch = /^\\([a-z]+)(-?\d+)? ?/i.exec(rtf.slice(i, i + 40));
      if (wordMatch) {
        const [, word, argStr] = wordMatch;
        const arg = argStr !== undefined ? Number(argStr) : null;
        i += wordMatch[0].length;
        if (RTF_DESTINATIONS.has(word)) skip = true;
        else if (word === "uc" && arg !== null) ucSkip = Math.max(0, arg);
        else if (word === "u" && arg !== null) {
          if (!skip) out += String.fromCodePoint(arg < 0 ? arg + 65536 : arg);
          // Swallow the ANSI fallback bytes that follow \uN (usually one \'xx).
          for (let k = 0; k < ucSkip && i < rtf.length; k++) {
            if (rtf[i] === "\\" && rtf[i + 1] === "'") i += 4;
            else i++;
          }
        } else if (!skip) {
          if (word === "par" || word === "line") out += "\n";
          else if (word === "tab") out += "\t";
          else if (word === "emdash") out += "—";
          else if (word === "endash") out += "–";
          else if (word === "bullet") out += "•";
          else if (word === "lquote") out += "\u2018";
          else if (word === "rquote") out += "\u2019";
          else if (word === "ldblquote") out += "\u201c";
          else if (word === "rdblquote") out += "\u201d";
        }
      } else {
        const sym = rtf[i + 1];
        if (sym === "'") {
          const byte = parseInt(rtf.slice(i + 2, i + 4), 16);
          if (!skip && !Number.isNaN(byte)) out += cp1252(byte);
          i += 4;
        } else {
          // \* marks a destination group readers may skip entirely.
          if (sym === "*") skip = true;
          // \<newline> is Apple's paragraph-mark control symbol (textutil).
          else if ((sym === "\n" || sym === "\r") && !skip) out += "\n";
          else if (!skip) {
            if (sym === "~") out += " ";
            else if (sym === "_" || sym === "-") out += "-";
            else if (sym === "{" || sym === "}" || sym === "\\") out += sym;
          }
          i += 2;
        }
      }
    } else if (ch === "\n" || ch === "\r") {
      i++; // raw newlines in RTF source are insignificant
    } else {
      if (!skip) out += ch;
      i++;
    }
  }
  return out
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* --------------------------- plain text & HTML ----------------------------- */

/** Decode bytes as UTF-8, falling back to Windows-1252 (Excel CSV exports). */
export function decodePlainText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return decodeCp1252(bytes);
  }
}

/**
 * Latin-1 with the C1 range (0x80–0x9F) remapped to cp1252 punctuation — this
 * is exactly the WHATWG windows-1252 table, but works identically even where
 * TextDecoder("windows-1252") is unreliable (e.g. small-icu Node builds).
 */
function decodeCp1252(bytes: Uint8Array): string {
  const latin1 = new TextDecoder("iso-8859-1").decode(bytes);
  let out = "";
  for (const ch of latin1) {
    const code = ch.codePointAt(0)!;
    out += code >= 0x80 && code <= 0x9f ? CP1252_HIGH[code] ?? ch : ch;
  }
  return out;
}

/** Uploaded .html — strip boilerplate like the /url fetcher does. */
function extractHtmlText(raw: string): string {
  const doc = new DOMParser().parseFromString(raw, "text/html");
  doc.querySelectorAll("script,style,noscript,svg,iframe,nav,footer,header,form,aside")
    .forEach((el) => el.remove());
  return cap(collapseWhitespace(doc.body?.textContent ?? ""));
}

/* ------------------------------ binary guard ------------------------------- */

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; // legacy Office

function hasMagic(bytes: Uint8Array, magic: number[]): boolean {
  return magic.every((b, i) => bytes[i] === b);
}

/** A NUL byte in the first 8 KB is a reliable tell for non-text content. */
function looksBinary(bytes: Uint8Array): boolean {
  const len = Math.min(bytes.length, 8192);
  for (let i = 0; i < len; i++) if (bytes[i] === 0) return true;
  return false;
}

const LEGACY_OFFICE_MSG =
  "legacy Office format (.doc/.xls/.ppt) isn't supported — save it as .docx/.xlsx/.pptx (or PDF) and re-add.";

/* ------------------------------- dispatcher -------------------------------- */

/**
 * Extract readable text from a non-PDF, non-media file.
 * Throws a user-friendly Error for formats that can't be read — the ingest
 * layer catches it and reports the file as failed (nothing is stored).
 */
export async function extractFileText(file: File): Promise<ExtractedText> {
  const name = file.name.toLowerCase();
  const bytes = new Uint8Array(await file.arrayBuffer());

  const office = (text: string): ExtractedText =>
    text.trim().length < 100
      ? {
          text,
          warning: `${file.name}: almost no extractable text — it may be image-based or empty. It was added, but the AI can't read its contents.`,
        }
      : { text };

  try {
    if (name.endsWith(".pptx")) return office(extractPptxText(bytes));
    if (name.endsWith(".docx")) return office(extractDocxText(bytes));
    if (name.endsWith(".xlsx")) return office(extractXlsxText(bytes));
    if (name.endsWith(".epub")) return office(extractEpubText(bytes));
  } catch {
    throw new Error("couldn't read this file — it may be corrupted or not really what its extension says.");
  }

  if (name.endsWith(".rtf")) return { text: cap(rtfToPlainText(decodePlainText(bytes))) };
  if (name.endsWith(".html") || name.endsWith(".htm"))
    return { text: extractHtmlText(decodePlainText(bytes)) };
  if (/\.(doc|xls|ppt)$/i.test(name)) throw new Error(LEGACY_OFFICE_MSG);

  // Generic path: judge by content, not extension, so drag-dropped binaries
  // fail loudly instead of being stored as decoded-garbage "text".
  if (hasMagic(bytes, ZIP_MAGIC))
    throw new Error(
      "zip-based files of this kind aren't supported (BrewLM reads .docx, .xlsx, .pptx, and .epub — not archives or other zip formats)."
    );
  if (hasMagic(bytes, OLE_MAGIC)) throw new Error(LEGACY_OFFICE_MSG);
  if (looksBinary(bytes))
    throw new Error(
      "unsupported binary file type — BrewLM reads PDFs, Office docs (.docx/.xlsx/.pptx), ePubs, text, images, and audio."
    );
  return { text: cap(decodePlainText(bytes)) };
}
