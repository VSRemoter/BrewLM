/** Shared file ingestion: turns dropped/picked files into notebook sources. */

import { MAX_SYNC_FILE_BYTES, putBlob } from "./blobs";
import { addSource } from "./db";
import { extractFileText } from "./extractors";
import { describeImage, TRANSCRIPT_ONLY, transcribeAudio } from "./media";
import { indexSource } from "./rag";
import { loadSettings } from "./settings";
import { classifyFile, extractPdfText, readFileAsDataUrl } from "./source";
import type { Source } from "./types";

const MB = 1024 * 1024;
const MAX_BINARY_BYTES = 8 * MB; // 8 MB for originals kept as-is (images, audio that couldn't be compressed)

/**
 * PDFs, documents and images are read whole into memory before anything
 * else happens, so a huge one could freeze or crash the app. Files over these
 * are refused by their size alone, without reading them. (Audio and video are
 * read in pieces and have no such limit.)
 */
export const MAX_READ_BYTES: Partial<Record<Source["type"], number>> = {
  pdf: 200 * MB,
  text: 100 * MB,
  file: 100 * MB,
  image: 50 * MB,
};
const READ_KIND: Partial<Record<Source["type"], string>> = { pdf: "PDFs", text: "Documents", file: "Documents", image: "Images" };

/** Why a file is refused before it's read, or null when its size is fine. */
export function tooLargeToRead(type: Source["type"], name: string, size: number): string | null {
  const limit = MAX_READ_BYTES[type];
  if (!limit || size <= limit) return null;
  return `${name} is ${Math.round(size / MB).toLocaleString()} MB. ${READ_KIND[type]} can be up to ${limit / MB} MB, so it wasn't added.`;
}

/** "5 h 12 min" */
function hoursMinutes(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

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
    const refused = tooLargeToRead(type, file.name, file.size);
    if (refused) {
      errors.push(refused);
      continue;
    }
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
          // Over about 4½ hours the compressed recording passes Sync's file limit: it stays here (sync.ts skips it).
          if (media.recording.bytes.length > MAX_SYNC_FILE_BYTES)
            errors.push(
              `${file.name}: added. Its recording is ${hoursMinutes(media.recording.duration)} (${Math.round(media.recording.bytes.length / MB)} MB), over Sync's 100 MB limit, so it plays only on this device. The transcript syncs as usual.`
            );
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
