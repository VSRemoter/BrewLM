/**
 * Generated-image hygiene.
 *
 * Image models (e.g. gemini-*-image via OpenRouter) return base64 data URIs,
 * often 1–5 MB each. Kept verbatim in chat history they would be re-sent to
 * the provider on every follow-up turn (HISTORY_LIMIT turns), silently adding
 * tens of thousands of billed input tokens per message. Two defenses:
 *
 * 1. `downscaleGeneratedImages` — shrink images before persisting the chat
 *    message (also keeps SQLite rows and the phone web UI lean).
 * 2. `stripHistoryImages` — remove image embeds entirely when re-sending past
 *    messages as LLM context, leaving a cheap textual placeholder.
 */

const IMAGE_EMBED_RE = /!\[([^\]]*)\]\((data:image\/[a-zA-Z0-9.+-]+;base64,[^)\s]+)\)/g;

/** Above ~300 KB of base64, re-encode; smaller images pass through unchanged. */
const DOWNSCALE_THRESHOLD = 400_000;
const MAX_DIM = 1024;
const JPEG_QUALITY = 0.85;

/** Downscale one base64 image data URI to a compact JPEG data URI. */
export function downscaleImageDataUri(
  dataUri: string,
  maxDim = MAX_DIM,
  quality = JPEG_QUALITY
): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(dataUri);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const out = canvas.toDataURL("image/jpeg", quality);
        resolve(out.length < dataUri.length ? out : dataUri);
      } catch {
        resolve(dataUri);
      }
    };
    img.onerror = () => resolve(dataUri);
    img.src = dataUri;
  });
}

/**
 * Downscale every large generated-image embed in a reply before it's saved.
 * Rendering is unaffected (data URIs still render inline), but the stored
 * message drops from megabytes to ~100 KB per image.
 */
export async function downscaleGeneratedImages(text: string): Promise<string> {
  const matches = [...text.matchAll(IMAGE_EMBED_RE)];
  if (matches.length === 0) return text;
  let out = text;
  for (const m of matches) {
    const [embed, alt, dataUri] = m;
    if (dataUri.length <= DOWNSCALE_THRESHOLD) continue;
    const small = await downscaleImageDataUri(dataUri);
    if (small !== dataUri) out = out.replace(embed, `![${alt}](${small})`);
  }
  return out;
}

/**
 * Strip image embeds from a past chat message before it re-enters LLM context.
 * The model gets a cheap placeholder; the pixels stay visible only in the UI.
 */
export function stripHistoryImages(content: string): string {
  if (!content.includes("data:image/")) return content;
  return content.replace(IMAGE_EMBED_RE, "[$1 — an image was generated here]").trim();
}
