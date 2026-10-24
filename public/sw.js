/*
 * BrewLM web app service worker (the desktop app never registers it).
 *
 * Serves media files from Cache Storage at /_media/<sha256>.<ext> — the web
 * build's version of the desktop `brewblob:` scheme (src/platform/web.ts).
 * Byte ranges are answered with 206, which Safari needs to play and seek audio.
 */
const MEDIA_CACHE = "brewlm-media";
const MEDIA_PATH = "/_media/";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(MEDIA_PATH)) return;
  e.respondWith(serveMedia(e.request, url));
});

async function serveMedia(request, url) {
  const cache = await caches.open(MEDIA_CACHE);
  // The query (?arrived, see lib/blobs.ts) only forces a reload; files are keyed by path.
  const hit = await cache.match(url.origin + url.pathname);
  if (!hit) return new Response("media file not on this device", { status: 404 });
  const headers = {
    "content-type": hit.headers.get("content-type") || "application/octet-stream",
    "accept-ranges": "bytes",
    // Content-addressed: a name's bytes never change.
    "cache-control": "public, max-age=31536000, immutable",
  };
  const blob = await hit.blob();
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") || "");
  if (!range || (range[1] === "" && range[2] === "")) {
    return new Response(blob, { headers: { ...headers, "content-length": String(blob.size) } });
  }
  let start, end;
  if (range[1] === "") {
    // "bytes=-500": the last 500 bytes.
    start = Math.max(0, blob.size - Number(range[2]));
    end = blob.size - 1;
  } else {
    start = Number(range[1]);
    end = range[2] === "" ? blob.size - 1 : Math.min(Number(range[2]), blob.size - 1);
  }
  if (start >= blob.size || start > end) {
    return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${blob.size}` } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      ...headers,
      "content-length": String(end - start + 1),
      "content-range": `bytes ${start}-${end}/${blob.size}`,
    },
  });
}
