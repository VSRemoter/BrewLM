/**
 * The desktop's document file writers and previews, bundled for the paired
 * phone's page (src-tauri/mobile.js loads this on a document's first preview
 * or download, like mermaid.js), so the phone shows and saves exactly what
 * the desktop does. Built by scripts/build-phone-render.mjs; served at
 * /assets/docfile.js.
 */
import { DOC_FORMAT_INFO, documentFile, documentSummary, parseDocument, sheetDisplay } from "../lib/document";
import { docHtml, sheetHtml, slideHtml, tabColor } from "../lib/docfile/preview";

(window as unknown as { BrewDocFile: unknown }).BrewDocFile = {
  /** The file for a document's stored data: { bytes, ext, mime } (bytes are text for Markdown). */
  async build(data: string, title: string) {
    const d = parseDocument(data);
    if (!d) throw new Error("This document's data looks malformed.");
    const f = await documentFile(d, title);
    return { bytes: f.data, ext: f.ext, mime: f.mime };
  },
  parse: parseDocument,
  sheetDisplay,
  summary: documentSummary,
  info: DOC_FORMAT_INFO,
  // Previews, as HTML (text escaped, colors and fonts checked).
  slideHtml,
  docHtml,
  sheetHtml,
  tabColor,
};
