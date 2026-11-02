/** Shared file ingestion: turns dropped/picked files into notebook sources. */

import { putBlob } from "./blobs";
import { addSource } from "./db";
import { extractFileText } from "./extractors";
import { describeImage, TRANSCRIPT_ONLY, transcribeAudio } from "./media";
import { indexSource } from "./rag";
import { loadSettings } from "./settings";
import { classifyFile, extractPdfText, readFileAsDataUrl } from "./source";
import type { Source } from "./types";

const MAX_BINARY_BYTES = 8 * 1024 * 1024; // 8 MB for originals kept as-is (images, audio that couldn't be compressed)

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
  const settings = await loadSettings();
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
      } else if (type === "image") {
        // The image is kept for preview, and described + OCR'd so the model can read it.
        const media = await describeImage(file);
        if (media.warning) errors.push(`${file.name}: added, but the AI can't read it yet — ${media.warning}`);
        const content =
          file.size > MAX_BINARY_BYTES
            ? `[image attached but too large to embed: ${(file.size / 1024 / 1024).toFixed(1)} MB]`
            : await readFileAsDataUrl(file);
        added.push(await addSource(notebookId, type, file.name, content, file.type, media.text));
      } else {
        // Audio / video: transcribed for the model. For playback the compressed
        // soundtrack is kept (video dropped) — unless the user chose transcript
        // only, in which case it's kept only until a transcript exists to retry from.
        const media = await transcribeAudio(file, file.name, settings);
        if (media.warning) errors.push(`${file.name}: added, but the AI can't read it yet — ${media.warning}`);
        const keep = settings.keepRecordings || !media.text;
        let content: string;
        let mime: string | null = file.type;
        if (keep && media.recording) {
          content = await putBlob(media.recording.bytes, "m4a");
          mime = "audio/mp4";
        } else if (keep && file.size <= MAX_BINARY_BYTES) {
          content = await readFileAsDataUrl(file);
        } else if (keep) {
          content = `[audio attached but too large to embed: ${(file.size / 1024 / 1024).toFixed(1)} MB]`;
        } else {
          content = TRANSCRIPT_ONLY;
        }
        added.push(await addSource(notebookId, type, file.name, content, mime, media.text));
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
