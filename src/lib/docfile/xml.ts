/**
 * Small helpers shared by the Office file writers (docx.ts, pptx.ts, xlsx.ts):
 * XML escaping, the package's standard parts, and zipping it all up.
 */
import { strToU8, zipSync } from "fflate";

/** Characters XML 1.0 can't hold: control characters and U+FFFE/F. */
const BAD_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
/** A surrogate pair (kept) or a lone surrogate (dropped). No lookbehind: older phone browsers lack it. */
const SURROGATES = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;

/** Text safe inside an XML element or a double-quoted attribute. */
export function esc(s: string): string {
  return s
    .replace(BAD_XML, "")
    .replace(SURROGATES, (m) => (m.length === 2 ? m : ""))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export const REL = {
  officeDocument: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  core: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
  app: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties",
  base: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/",
};

export const CT = {
  rels: "application/vnd.openxmlformats-package.relationships+xml",
  core: "application/vnd.openxmlformats-package.core-properties+xml",
  app: "application/vnd.openxmlformats-officedocument.extended-properties+xml",
  theme: "application/vnd.openxmlformats-officedocument.theme+xml",
};

/** A relationships part. `type` is a full URI, or a name under the officeDocument namespace. */
export function rels(list: { id: string; type: string; target: string; external?: boolean }[]): string {
  return `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list
    .map(
      (r) =>
        `<Relationship Id="${r.id}" Type="${r.type.includes("://") ? r.type : REL.base + r.type}" Target="${esc(r.target)}"${
          r.external ? ' TargetMode="External"' : ""
        }/>`
    )
    .join("")}</Relationships>`;
}

/** [Content_Types].xml: rels and xml by extension, every other part by name. */
export function contentTypes(overrides: Record<string, string>): string {
  return `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="${CT.rels}"/><Default Extension="xml" ContentType="application/xml"/>${Object.entries(
    overrides
  )
    .map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`)
    .join("")}</Types>`;
}

/** W3C date-time without milliseconds, as Office writes it. */
export function w3cDate(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** docProps/core.xml: the title and when it was made. */
export function coreProps(title: string, date: Date): string {
  const when = w3cDate(date);
  return `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(
    title
  )}</dc:title><dc:creator>BrewLM</dc:creator><cp:lastModifiedBy>BrewLM</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${when}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${when}</dcterms:modified></cp:coreProperties>`;
}

/** docProps/app.xml: the application that wrote it. */
export function appProps(): string {
  return `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>BrewLM</Application></Properties>`;
}

/** The package as a zip, [Content_Types].xml first. */
export function zipParts(parts: Record<string, string>): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  // Content types first: some readers sniff the package from the first entry.
  const order = ["[Content_Types].xml", ...Object.keys(parts).filter((k) => k !== "[Content_Types].xml")];
  for (const name of order) files[name] = strToU8(parts[name]);
  return zipSync(files, { level: 6, mtime: new Date(2026, 0, 1) });
}
