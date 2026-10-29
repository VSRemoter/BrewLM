import { fetchWebPage } from "./webFetch";
// WKWebView (and older Safari) may lack ES2024 APIs the modern pdf.js build
// uses (Promise.withResolvers, async helpers) — the legacy build is transpiled
// for exactly these environments.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { SourceType } from "./types";
import { extractFileText, MAX_SOURCE_CHARS } from "./extractors";
import { fetchYouTubeTranscript, isYouTubeUrl } from "./youtube";

// Belt-and-braces for environments without ES2024 Promise.withResolvers.
type WithResolvers = {
  withResolvers<T>(): {
    promise: Promise<T>;
    resolve: (v: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  };
};
const P = Promise as unknown as WithResolvers;
if (typeof P.withResolvers !== "function") {
  P.withResolvers = function withResolvers<T>() {
    let resolve!: (v: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

// WebKit/Safari's ReadableStream is NOT async-iterable, but pdf.js 6.x consumes
// text-content streams with `for await (const value of readableStream)`.
// Without this, PDF import fails under WKWebView with
// "TypeError: undefined is not a function (near '...value of readableStream...')".
const rsProto = (globalThis as { ReadableStream?: { prototype?: object } })
  .ReadableStream?.prototype;
if (rsProto && !(Symbol.asyncIterator in rsProto)) {
  (rsProto as Record<PropertyKey, unknown>)[Symbol.asyncIterator] = function (
    this: ReadableStream
  ) {
    const reader = this.getReader();
    return {
      next: () => reader.read(),
      return: async () => {
        await reader.cancel();
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  };
}

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

export const ACCEPT_STRING =
  ".pdf,.pptx,.docx,.xlsx,.epub,.rtf,.txt,.md,.markdown,.csv,.json,.html,text/*,image/*,audio/*,video/*";

export function classifyFile(file: File): SourceType {
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"))
    return "pdf";
  if (file.type.startsWith("image/")) return "image";
  // Video is transcribed from its soundtrack, so it rides the audio path.
  if (file.type.startsWith("audio/") || file.type.startsWith("video/")) return "audio";
  if (file.type.startsWith("text/") || /\.(md|markdown|txt|csv|json)$/i.test(file.name))
    return "text";
  return "file";
}

export async function extractPdfText(file: Blob): Promise<string> {
  return extractPdfBytes(new Uint8Array(await file.arrayBuffer()));
}

async function extractPdfBytes(data: Uint8Array): Promise<string> {
  const pdf = await pdfjs.getDocument({ data }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const items: unknown[] = Array.isArray(tc?.items) ? tc.items : [];
    const text = items
      .map((item) =>
        item && typeof item === "object" && "str" in item
          ? String((item as { str?: unknown }).str ?? "")
          : ""
      )
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) parts.push(`[Page ${i}] ${text}`);
  }
  return parts.join("\n\n");
}

export function readFileAsText(file: File): Promise<string> {
  return file.text();
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Downscale an image file into a compact JPEG data URL for notebook covers.
 * Cards render ~230px wide, so 560px covers 2x displays; JPEG keeps the
 * SQLite row small (a raw PNG photo would bloat the notebooks table).
 */
export function fileToCoverDataUrl(file: File, maxWidth = 560, quality = 0.82): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxWidth / img.naturalWidth);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("Canvas is unavailable."));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file doesn't look like an image."));
    };
    img.src = url;
  });
}

/** Tags whose text starts on its own line, so adjacent blocks don't run together ("Log inSign up"). */
const BLOCK_TAGS = new Set([
  "address", "article", "blockquote", "dd", "details", "div", "dl", "dt", "fieldset", "figcaption",
  "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "li", "main", "ol", "p", "pre", "section",
  "summary", "table", "tbody", "thead", "tfoot", "tr", "ul",
]);

/** A parsed page's readable text, with line breaks between blocks and spaces between table cells and buttons. */
function htmlToText(root: Node): string {
  const out: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = (node as Element).tagName.toLowerCase();
    if (tag === "br") return void out.push("\n");
    const block = BLOCK_TAGS.has(tag);
    if (block) out.push("\n");
    for (const child of Array.from(node.childNodes)) walk(child);
    if (block) out.push("\n");
    else if (tag === "td" || tag === "th" || tag === "button") out.push(" ");
  };
  walk(root);
  return out
    .join("")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Pages that render only with JavaScript, or only after signing in, come back as this kind of stub. */
const SHELL_PAGE_RE = /(enable|turn on|requires?) javascript|javascript is (not available|disabled)|log ?in to continue|sign ?in to continue/i;

/**
 * Fetches a URL (see webFetch.ts: direct on desktop, via the sync server on the web) and extracts readable text.
 * `finalUrl` is where the page ended up after redirects (a Google "goto" link → the article itself).
 */
export async function fetchLinkContent(url: string): Promise<{ title: string; text: string; finalUrl: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
  } catch {
    throw new Error("That doesn't look like a valid URL.");
  }
  // Video pages are player boilerplate as HTML; read the transcript instead.
  if (isYouTubeUrl(parsed.toString()))
    return { ...(await fetchYouTubeTranscript(parsed.toString())), finalUrl: parsed.toString() };

  const res = await fetchWebPage(parsed.toString(), {
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,text/plain,application/pdf;q=0.9,*/*;q=0.5",
    },
  });
  if (!res.ok) throw new Error(`Couldn't fetch that page (HTTP ${res.status}).`);
  const finalUrl = res.headers.get("x-final-url") || res.url || parsed.toString();

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const fileName = decodeURIComponent(parsed.pathname.split("/").pop() || "") || parsed.hostname;

  // Linked PDFs: extract their text like an uploaded PDF, not as raw bytes.
  if (contentType.includes("pdf") || /\.pdf$/i.test(parsed.pathname)) {
    const text = await extractPdfBytes(new Uint8Array(await res.arrayBuffer()));
    if (text.trim().length < 200)
      throw new Error("That PDF has almost no extractable text (it looks scanned/image-only). Download it, run OCR, then add the file.");
    return { title: fileName, text: text.slice(0, MAX_SOURCE_CHARS), finalUrl };
  }
  if (/^(image|audio|video)\//.test(contentType))
    throw new Error("That link points to a media file, not a web page — download it and add it with the upload button so the AI can read it.");
  // Linked documents (.docx/.xlsx/.pptx/.epub/.rtf…): same extractor as uploads.
  if (/octet-stream|zip|officedocument|msword|ms-excel|ms-powerpoint|epub|rtf/.test(contentType)) {
    const bytes = await res.arrayBuffer();
    const { text } = await extractFileText(new File([bytes], fileName, { type: contentType }));
    if (!text.trim()) throw new Error("That file was downloaded but has no readable text.");
    return { title: fileName, text, finalUrl };
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!contentType.includes("html")) {
    // Plain text, CSV, JSON… or a file behind an unexpected content type. The
    // file extractor decodes text and rejects binaries, so a link's raw bytes
    // are never stored as a source.
    let text: string;
    try {
      ({ text } = await extractFileText(new File([bytes], fileName, { type: contentType })));
    } catch (e) {
      throw new Error(`That link isn't a page BrewLM can read — ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!text.trim()) throw new Error("The link loaded but no readable text was found.");
    return { title: parsed.hostname, text: text.slice(0, MAX_SOURCE_CHARS), finalUrl };
  }
  const raw = new TextDecoder().decode(bytes);

  const doc = new DOMParser().parseFromString(raw, "text/html");
  doc.querySelectorAll("script,style,noscript,svg,iframe,nav,footer,header,form,aside").forEach((el) => el.remove());
  const title =
    doc.querySelector("title")?.textContent?.trim() ||
    parsed.hostname;
  const text = doc.body ? htmlToText(doc.body) : "";
  if (!text) throw new Error("The page loaded but no readable text was found.");
  if (text.length < 400 && SHELL_PAGE_RE.test(text))
    throw new Error("That page only shows its content in a browser with JavaScript or after signing in, so BrewLM can't read it. Copy the text and add it with Paste text instead.");
  return { title: `${title}`, text: text.slice(0, MAX_SOURCE_CHARS), finalUrl };
}

export function sourcePreview(content: string, max = 90): string {
  const t = content.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay)
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
