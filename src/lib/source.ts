import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
// WKWebView (and older Safari) may lack ES2024 APIs the modern pdf.js build
// uses (Promise.withResolvers, async helpers) — the legacy build is transpiled
// for exactly these environments.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { SourceType } from "./types";

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
  ".pdf,.txt,.md,.markdown,.csv,.json,.html,text/*,image/*,audio/*";

export function classifyFile(file: File): SourceType {
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"))
    return "pdf";
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("text/") || /\.(md|markdown|txt|csv|json)$/i.test(file.name))
    return "text";
  return "file";
}

export async function extractPdfText(file: File): Promise<string> {
  const data = new Uint8Array(await file.arrayBuffer());
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

/** Fetches a URL through the Tauri HTTP plugin (no CORS) and extracts readable text. */
export async function fetchLinkContent(url: string): Promise<{ title: string; text: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
  } catch {
    throw new Error("That doesn't look like a valid URL.");
  }

  const res = await tauriFetch(parsed.toString(), {
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,text/plain",
    },
    connectTimeout: 20000,
  });
  if (!res.ok) throw new Error(`Couldn't fetch that page (HTTP ${res.status}).`);

  const contentType = res.headers.get("content-type") ?? "";
  const raw = await res.text();

  if (!contentType.includes("html")) {
    return { title: parsed.hostname, text: raw.slice(0, 200_000) };
  }

  const doc = new DOMParser().parseFromString(raw, "text/html");
  doc.querySelectorAll("script,style,noscript,svg,iframe,nav,footer,header,form,aside").forEach((el) => el.remove());
  const title =
    doc.querySelector("title")?.textContent?.trim() ||
    parsed.hostname;
  const text = (doc.body?.textContent ?? "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
  if (!text) throw new Error("The page loaded but no readable text was found.");
  return { title: `${title}`, text: text.slice(0, 200_000) };
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
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
