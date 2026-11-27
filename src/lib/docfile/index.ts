/**
 * Office files from a document's content: Word, PowerPoint and Excel, written
 * here with no library beyond the zip the app already uses, so the same code
 * builds them on the desktop, in the web app and on a paired phone
 * (src/phone/docfile.ts). Loaded on first download (document.ts).
 */
import type { DocumentData } from "../document";
import { buildDocx } from "./docx";
import { buildPptx } from "./pptx";
import { buildXlsx } from "./xlsx";

export { buildDocx, buildPptx, buildXlsx };

/** The file's bytes for a Word, PowerPoint or Excel document. */
export function buildOfficeFile(d: DocumentData, title: string, date?: Date): Uint8Array {
  switch (d.format) {
    case "docx":
      return buildDocx(d.markdown ?? "", { title, date, style: d.style });
    case "pptx":
      return buildPptx(d.slides ?? [], { title, date, theme: d.theme });
    case "xlsx":
      return buildXlsx(d.sheets ?? [], { title, date, style: d.sheetStyle });
    default:
      throw new Error("Markdown files are saved as text.");
  }
}
