import { File as FileIcon, FileText, Image as ImageIcon, Landmark, Link2, Music, Type } from "lucide-react";
import type { SourceType } from "../lib/types";

/** The icon each kind of source shows, in the Sources panel and source pickers. */
export const SOURCE_TYPE_ICON: Record<SourceType, typeof FileText> = {
  context: Landmark,
  pdf: FileText,
  text: Type,
  link: Link2,
  image: ImageIcon,
  audio: Music,
  file: FileIcon,
};
