/**
 * Media file store (desktop: src-tauri/src/blobs.rs; web: Cache Storage, see platform/web.ts).
 *
 * Podcast audio, images, covers and chat backgrounds are files named by their
 * SHA-256 (`<app data>/blobs/<hash>.<ext>`); rows hold a `brewblob:<hash>.<ext>`
 * reference instead of a multi-megabyte base64 data URL. Values written before
 * the move (or kept inline because a format isn't recognised) stay data URLs,
 * so every reader accepts both:
 *
 * - `mediaSrc(v)`      — URL for <img>/<audio>/fetch (the `brewblob` scheme, or the web service worker)
 * - `mediaBlob(v)`     — the bytes, for uploads to vision/transcription APIs
 * - `mediaDataUrl(v)`  — an inline data URL, where an API needs one
 * - `storeMedia(v)`    — data URL in, reference out (db.ts calls it on every write)
 */
import { platform } from "../platform";

export const BLOB_PREFIX = "brewblob:";
const REF_RE = /brewblob:[0-9a-f]{64}\.[a-z0-9]{1,5}/g;

/** Extensions the store uses; mimes outside this list stay inline. */
const EXT_FOR_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/webm": "weba",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "application/pdf": "pdf",
};

export function isBlobRef(v: string | null | undefined): boolean {
  return typeof v === "string" && v.startsWith(BLOB_PREFIX);
}

/** True when the value holds media bytes: an inline data URL or a stored file. */
export function isMediaValue(v: string | null | undefined): boolean {
  return typeof v === "string" && (v.startsWith("data:") || v.startsWith(BLOB_PREFIX));
}

/** Every reference inside a text (artifact JSON, message markdown…). */
export function blobRefsIn(text: string): string[] {
  return text.includes(BLOB_PREFIX) ? text.match(REF_RE) ?? [] : [];
}

/** File extension of a reference (or a data URL's mime), e.g. "m4a". */
export function mediaExt(v: string): string {
  if (isBlobRef(v)) return v.slice(v.lastIndexOf(".") + 1);
  const mime = v.startsWith("data:") ? v.slice(5, v.indexOf(";")) : "";
  return EXT_FOR_MIME[mime] ?? "bin";
}

/** Files Sync downloaded this session (see `markArrived`). */
const arrived = new Set<string>();

/**
 * Sync calls this when a file another device made lands here. Its URL gains a
 * query string, so an <img>/<audio> that already failed on the missing file
 * loads again on the next render (the scheme ignores the query).
 */
export function markArrived(name: string): void {
  arrived.add(name);
}

/** Loadable URL for a stored value. Data URLs and http(s) URLs pass through. */
export function mediaSrc(v: string): string {
  if (!isBlobRef(v)) return v;
  const name = v.slice(BLOB_PREFIX.length);
  const url = platform.blobs.url(name);
  return arrived.has(name) ? `${url}?arrived` : url;
}

export async function mediaBlob(v: string): Promise<Blob> {
  const res = await fetch(mediaSrc(v));
  if (!res.ok) throw new Error(`media file missing (${res.status})`);
  return res.blob();
}

export async function mediaBytes(v: string): Promise<Uint8Array> {
  return new Uint8Array(await (await mediaBlob(v)).arrayBuffer());
}

export async function mediaDataUrl(v: string): Promise<string> {
  if (!isBlobRef(v)) return v;
  const blob = await mediaBlob(v);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("couldn't read media file"));
    reader.readAsDataURL(blob);
  });
}

/** Write bytes to the store; returns their reference. */
export async function putBlob(bytes: Uint8Array, ext: string): Promise<string> {
  return platform.blobs.put(bytes, ext);
}

/**
 * Move a base64 data URL into the store and return its reference. Anything
 * else (references, text, http URLs, unknown formats) comes back unchanged,
 * and so does the data URL itself if saving fails — media is never lost.
 */
export async function storeMedia(v: string): Promise<string> {
  if (!v.startsWith("data:")) return v;
  const header = v.slice(5, v.indexOf(","));
  const ext = EXT_FOR_MIME[header.split(";")[0].toLowerCase()];
  if (!ext || !header.endsWith(";base64")) return v;
  try {
    const bytes = new Uint8Array(await (await fetch(v)).arrayBuffer());
    return await putBlob(bytes, ext);
  } catch (e) {
    console.warn("media store: save failed, keeping inline", e);
    return v;
  }
}

/** storeMedia for the `audio` field of an audio-overview artifact's JSON. */
export async function storeArtifactMedia(data: string): Promise<string> {
  if (!data.includes('"audio":"data:') && !data.includes('"audio": "data:')) return data;
  try {
    const parsed = JSON.parse(data);
    if (typeof parsed?.audio !== "string" || !parsed.audio.startsWith("data:")) return data;
    const ref = await storeMedia(parsed.audio);
    return ref === parsed.audio ? data : JSON.stringify({ ...parsed, audio: ref });
  } catch {
    return data;
  }
}

/** Delete files no row references (grace period covers in-flight writes). */
export async function gcBlobs(keep: string[], graceMs = 10 * 60_000): Promise<{ removed: number; freed_bytes: number }> {
  return platform.blobs.gc(keep, graceMs);
}
