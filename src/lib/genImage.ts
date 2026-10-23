/**
 * Generated-image hygiene + the image library.
 *
 * Image models return base64 data URIs, often 1–5 MB each. Kept verbatim in
 * chat history they would bloat SQLite rows and, worse, be re-sent to the
 * provider on every follow-up turn. So:
 *
 * 1. `storeGeneratedImages` — move every generated image into the `images`
 *    table and leave a tiny `![alt](brewimg:<id>)` reference in the message.
 * 2. `stripHistoryImages` — when past messages re-enter LLM context, replace
 *    image embeds/references with a one-line textual placeholder.
 * 3. `withLibraryImages` — resolve `<img data-brewimg>` tags in rendered chat
 *    bubbles from the library (cached blob URLs), with Edit / Remix / More
 *    like this hover actions.
 */
import { isBlobRef, mediaDataUrl, mediaSrc } from "./blobs";
import { addImage, getImage, type LibraryImage } from "./db";

/** Inline base64 embeds (chat-model output, and messages saved before the library). */
const IMAGE_EMBED_RE = /!\[([^\]]*)\]\((data:image\/[a-zA-Z0-9.+-]+;base64,[^)\s]+)\)/g;
/** Library references. */
const IMAGE_REF_RE = /!\[([^\]]*)\]\(brewimg:([a-zA-Z0-9-]+)\)/g;

/** Above ~300 KB of base64, re-encode; smaller images pass through unchanged. */
const DOWNSCALE_THRESHOLD = 400_000;
/** Library copies keep enough detail for a later remix/edit pass. */
const MAX_DIM = 1536;
const JPEG_QUALITY = 0.9;

interface Normalized {
  dataUri: string;
  width: number;
  height: number;
}

/** Decode a data URI, shrinking it to a JPEG when it's large. Never throws. */
function normalizeImage(dataUri: string): Promise<Normalized> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (dataUri.length <= DOWNSCALE_THRESHOLD) return resolve({ dataUri, width: w, height: h });
      try {
        const scale = Math.min(1, MAX_DIM / Math.max(w, h));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve({ dataUri, width: w, height: h });
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const out = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
        resolve(
          out.length < dataUri.length
            ? { dataUri: out, width: canvas.width, height: canvas.height }
            : { dataUri, width: w, height: h }
        );
      } catch {
        resolve({ dataUri, width: w, height: h });
      }
    };
    img.onerror = () => resolve({ dataUri, width: 0, height: 0 });
    img.src = dataUri;
  });
}

/** Alt text doubles as the image's description in LLM context — keep it one tidy line. */
export function imageAlt(prompt: string): string {
  const flat = prompt.replace(/[[\]()*_`\n\r]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > 140 ? flat.slice(0, 139) + "…" : flat || "generated image";
}

export function imageRef(id: string, alt: string): string {
  return `![${imageAlt(alt)}](brewimg:${id})`;
}

export interface ImageMeta {
  notebookId: string;
  chatId: string;
  prompt: string;
  model: string;
  parentId?: string;
}

/** Save one data-URI image into the library; returns its id. */
export async function saveImageToLibrary(dataUri: string, meta: ImageMeta): Promise<string> {
  const n = await normalizeImage(dataUri);
  const comma = n.dataUri.indexOf(",");
  const mime = /^data:([^;,]+)/.exec(n.dataUri)?.[1] ?? "image/png";
  return addImage({
    notebook_id: meta.notebookId,
    chat_id: meta.chatId,
    prompt: meta.prompt,
    model: meta.model,
    mime,
    data: n.dataUri.slice(comma + 1),
    width: n.width,
    height: n.height,
    parent_id: meta.parentId ?? "",
  });
}

/**
 * Move every inline base64 image in a reply into the library before the
 * message is saved, leaving `brewimg:` references. Falls back to the inline
 * embed if saving fails, so an image is never lost.
 */
export async function storeGeneratedImages(text: string, meta: ImageMeta): Promise<string> {
  const matches = [...text.matchAll(IMAGE_EMBED_RE)];
  if (matches.length === 0) return text;
  let out = text;
  for (const m of matches) {
    const [embed, , dataUri] = m;
    try {
      const id = await saveImageToLibrary(dataUri, meta);
      out = out.replace(embed, imageRef(id, meta.prompt));
    } catch (e) {
      console.warn("image library: save failed, keeping inline", e);
    }
  }
  return out;
}

/**
 * Strip image embeds and references from a past chat message before it
 * re-enters LLM context. The model gets the description; the pixels stay
 * visible only in the UI.
 */
export function stripHistoryImages(content: string): string {
  if (!content.includes("data:image/") && !content.includes("brewimg:")) return content;
  return content
    .replace(IMAGE_EMBED_RE, "[$1 — an image was generated here]")
    .replace(IMAGE_REF_RE, "[Image generated here: $1]")
    .trim();
}

/* ------------------------------ Edit / remix ------------------------------ */

/** Library ids referenced in a message, in order. */
export function imageIdsIn(content: string): string[] {
  if (!content.includes("brewimg:")) return [];
  return [...content.matchAll(IMAGE_REF_RE)].map((m) => m[2]);
}

/** References go out at most this size — plenty for an edit, a fraction of the upload. */
const REF_MAX_DIM = 1024;
const REF_JPEG_QUALITY = 0.85;

/**
 * A library image as a reference for an edit request: downscaled to ~1024px
 * JPEG data URI. Null if the image is gone.
 */
export async function libraryImageAsReference(id: string): Promise<string | null> {
  const img = await getImage(id);
  if (!img) return null;
  // A data URL keeps the canvas below untainted (and is the fallback upload).
  const src = await imageDataUrl(img);
  return new Promise((resolve) => {
    const el = new Image();
    el.onload = () => {
      try {
        const scale = Math.min(1, REF_MAX_DIM / Math.max(el.naturalWidth, el.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(el.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(el.naturalHeight * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(src);
        // JPEG has no alpha: paint transparent areas white rather than black.
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", REF_JPEG_QUALITY));
      } catch {
        resolve(src);
      }
    };
    el.onerror = () => resolve(src);
    el.src = src;
  });
}

/* ------------------------------ Rendering ------------------------------ */

const urlCache = new Map<string, Promise<string | null>>();
/** Settled lookups, readable synchronously while rendering. null = image is gone. */
const resolved = new Map<string, string | null>();

/** A library image as an inline data URL (stored file or legacy base64 row). */
async function imageDataUrl(img: LibraryImage): Promise<string> {
  return isBlobRef(img.data) ? mediaDataUrl(img.data) : `data:${img.mime};base64,${img.data}`;
}

/** URL for a library image (cached for the session); null if it's gone. */
export function libraryImageUrl(id: string): Promise<string | null> {
  let p = urlCache.get(id);
  if (!p) {
    p = getImage(id)
      .then((img) => {
        if (!img) return null;
        if (isBlobRef(img.data)) return mediaSrc(img.data);
        const bin = atob(img.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return URL.createObjectURL(new Blob([bytes], { type: img.mime }));
      })
      .catch(() => null)
      .then((url) => {
        resolved.set(id, url);
        return url;
      });
    urlCache.set(id, p);
  }
  return p;
}

/** Library ids referenced in a message that haven't been looked up yet. */
export function unresolvedImageIds(content: string): string[] {
  if (!content.includes("brewimg:")) return [];
  return [...content.matchAll(IMAGE_REF_RE)].map((m) => m[2]).filter((id) => !resolved.has(id));
}

/**
 * Put resolved URLs straight into rendered HTML (`<img data-brewimg="id">`
 * from renderMarkdown), so the src survives any re-render of the bubble.
 */
export function withLibraryImages(html: string): string {
  if (!html.includes("data-brewimg")) return html;
  return html.replace(/<img data-brewimg="([a-zA-Z0-9-]+)"([^>]*)>/g, (_tag, id: string, rest: string) => {
    const url = resolved.get(id);
    if (url === null) return `<img data-brewimg="${id}" class="missing"${rest}>`;
    if (!url) return `<img data-brewimg="${id}"${rest}>`;
    // Resolved pictures get hover actions (handled by the bubble's click delegate).
    const btn = (action: string, label: string, title: string) =>
      `<button type="button" data-img-action="${action}" data-img-id="${id}" title="${title}">${label}</button>`;
    return (
      `<span class="brewimg-wrap"><img data-brewimg="${id}" src="${url}"${rest}>` +
      `<span class="brewimg-actions">` +
      btn("edit", "Edit", "Change this picture — sends only it and your instruction") +
      btn("remix", "Remix", "New picture inspired by this one") +
      btn("more", "More like this", "Rerun this picture's prompt") +
      `</span></span>`
    );
  });
}
