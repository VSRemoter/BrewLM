/**
 * Reading pages on the open web (links added as sources, YouTube transcripts).
 * The desktop app fetches them itself, through Rust (no CORS). A browser can't
 * read most sites from another site's page, so the web app asks the sync
 * server to fetch them (sync-server/src/fetch.ts): same page, same Response.
 */
import { platform } from "../platform";
import { fetchThroughServer } from "./sync";

export interface WebFetchInit {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

export async function fetchWebPage(url: string, init: WebFetchInit = {}): Promise<Response> {
  if (platform.kind !== "desktop") return fetchThroughServer(url, init);
  // Tauri's HTTP plugin stamps every request with the webview's Origin
  // (tauri://localhost), which no real page visit carries and which makes
  // YouTube's player API refuse with 403 — so no captions. An empty Origin
  // tells the plugin (with its unsafe-headers feature) to send none. The
  // sync server's fetch never forwards Origin, so the web app needs nothing.
  const res = await platform.fetch(url, { ...init, headers: { ...init.headers, Origin: "" }, connectTimeout: 20000 });
  return decompressed(res);
}

/**
 * The Rust HTTP client is built without decompression on purpose: turning it
 * on makes every request advertise `Accept-Encoding: gzip, br…`, and sites
 * like the New York Times and Medium then refuse with 403 while Amazon serves
 * its robot check. Some sites (Amazon) compress anyway, unasked — so a gzip
 * or deflate body is unpacked here instead of being read as garbled text.
 */
export function decompressed(res: Response): Response {
  const enc = (res.headers.get("content-encoding") ?? "").trim().toLowerCase();
  const format = enc === "gzip" || enc === "x-gzip" ? "gzip" : enc === "deflate" ? "deflate" : null;
  if (!format || !res.body) return res;
  const headers = new Headers(res.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  const out = new Response(res.body.pipeThrough(new DecompressionStream(format)), {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
  // A constructed Response has no url; callers use it for redirects.
  Object.defineProperty(out, "url", { value: res.url });
  return out;
}

/** Bytes that are still gzip-compressed (a site that compressed without saying so) → unpacked; anything else as is. */
export async function gunzipIfCompressed(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length < 3 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 0x08) return bytes;
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return bytes;
  }
}
