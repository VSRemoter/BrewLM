/** Shared file ingestion: turns dropped/picked files into notebook sources. */

import { addSource } from "./db";
import { classifyFile, extractPdfText, readFileAsDataUrl, readFileAsText } from "./source";
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
        added.push(await addSource(notebookId, "pdf", file.name, text, file.type));
      } else if (type === "text" || type === "file") {
        const text = await readFileAsText(file).catch(() => "");
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
        // image / audio — embed small files as data URLs so they persist locally
        if (file.size > MAX_BINARY_BYTES) {
          added.push(
            await addSource(
              notebookId,
              type,
              file.name,
              `[${type} attached but too large to embed: ${(file.size / 1024 / 1024).toFixed(1)} MB]`,
              file.type
            )
          );
        } else {
          const dataUrl = await readFileAsDataUrl(file);
          added.push(await addSource(notebookId, type, file.name, dataUrl, file.type));
        }
      }
    } catch (e) {
      errors.push(`Failed to add ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  onBusy?.(null);
  return { added, errors };
}
