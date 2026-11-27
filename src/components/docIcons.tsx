/**
 * Each document file type's icon and color, so a Word file, a slide deck, a
 * spreadsheet and a Markdown file are told apart at a glance in Studio.
 */
import { FileCode, FilePen, FileSpreadsheet, FileType, Presentation } from "lucide-react";
import { docFormatOf, type DocFormat } from "../lib/document";

export const DOC_ICON: Record<DocFormat, typeof FileType> = {
  docx: FileType,
  pptx: Presentation,
  xlsx: FileSpreadsheet,
  md: FileCode,
};

/** Mid-tone colors that read on light and dark themes alike. */
export const DOC_COLOR: Record<DocFormat, string> = {
  docx: "text-[#3b82f6]",
  pptx: "text-[#ea7a2f]",
  xlsx: "text-[#22a05a]",
  md: "text-[#8b5cf6]",
};

/** The icon for a saved document's data (a generic file when the format can't be read). */
export function DocIcon({ data, format, size = 15, className = "" }: { data?: string; format?: DocFormat | null; size?: number; className?: string }) {
  const f = format ?? (data ? docFormatOf(data) : null);
  const Icon = f ? DOC_ICON[f] : FilePen;
  return <Icon size={size} strokeWidth={1.8} className={`${f ? DOC_COLOR[f] : "text-ink-2"} ${className}`} aria-hidden />;
}
