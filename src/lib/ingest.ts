/** Shared file ingestion: turns dropped/picked files into notebook sources. */

import { addSource } from "./db";
import { extractFileText } from "./extractors";
import { describeImage, transcribeAudio } from "./media";
import { indexSource } from "./rag";
import { classifyFile, extractPdfText, readFileAsDataUrl } from "./source";
import type { Source } from "./types";

const MAX_BINARY_BYTES = 8 * 1024 * 1024; // 8 MB for base64-embedded images/audio

export interface IngestResult {
  added: Source[];
  errors: string[];
}

export async function ingestFiles(
  notebookId: string,
  files: FileList | File[],
  onBusy?: (name: string | null) => void
): Promise<IngestResult> {
  const added: Source[] = [];
  const errors: string[] = [];
  for (const file of Array.from(files)) {
    const type = classifyFile(file);
    onBusy?.(file.name);
    try {
      if (type === "pdf") {
        const text = await extractPdfText(file);
        // Scanned/image-only PDFs yield ~no text: nothing to index or ground
        // in. Add the file, but say so loudly instead of failing silently.
        if (text.trim().length < 200) {
          errors.push(
            `${file.name}: almost no extractable text — this looks like a scanned/image-only PDF. It was added, but the AI can't read its contents; run OCR on it first, then re-add.`
          );
        }
        added.push(await addSource(notebookId, "pdf", file.name, text, file.type));
      } else if (type === "text" || type === "file") {
        // Office/eBook formats are parsed from their XML, markup formats are
        // cleaned, plain text is decoded (UTF-8 → cp1252 fallback), and
        // unreadable binaries throw — so garbage bytes never become a source.
        const { text, warning } = await extractFileText(file);
        if (warning) errors.push(warning);
        added.push(
          await addSource(
            notebookId,
            type,
            file.name,
            text || `Could not extract text from ${file.name}.`,
            file.type || null
          )
        );
      } else {
        // image / audio / video: the file itself is embedded (small ones) for
        // preview/playback, and converted to text the model can actually read
        // — a description + OCR for images, a transcript for audio and video.
        const media =
          type === "image" ? await describeImage(file) : await transcribeAudio(file, file.name);
        if (media.warning) {
          errors.push(
            `${file.name}: added, but the AI can't read it yet — ${media.warning}`
          );
        }
        const content =
          file.size > MAX_BINARY_BYTES
            ? `[${type} attached but too large to embed: ${(file.size / 1024 / 1024).toFixed(1)} MB]`
            : await readFileAsDataUrl(file);
        added.push(await addSource(notebookId, type, file.name, content, file.type, media.text));
      }
    } catch (e) {
      errors.push(`Failed to add ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  onBusy?.(null);
  // Chunk + embed new sources in the background so their content is fully
  // searchable by the time the first question lands (failures are silent —
  // the lazy ensureIndexed path retries before the next prompt).
  for (const s of added) void indexSource(s);
  return { added, errors };
}
