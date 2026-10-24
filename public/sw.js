/*
 * BrewLM web app service worker (the desktop app never registers it).
 *
 * Keeps the app itself so it opens offline: pages come from the network when
 * it answers (so an update shows up on the next launch) and from the saved
 * copy when it doesn't; the build's hashed files are saved as they load.
 * Each build registers this file with its own `?v=`, getting its own cache;
 * older ones are deleted. Development builds (`v=dev`) save nothing.
 *
 * Also serves media files from Cache Storage at /_media/<sha256>.<ext> — the web
 * build's version of the desktop `brewblob:` scheme (src/platform/web.ts).
 * Byte ranges are answered with 206, which Safari needs to play and seek audio.
 * A file this device doesn't have yet is asked of the page that wants it,
 * which downloads it through Sync (lib/sync.ts, fetchFileNow) and replies.
 */
const MEDIA_CACHE = "brewlm-media";
const MEDIA_PATH = "/_media/";
const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const SHELL_PREFIX = "brewlm-shell-";
const SHELL_CACHE = SHELL_PREFIX + VERSION;
const SAVES_SHELL = VERSION !== "dev";
/** Files that never change under the same name: the build's hashed assets, icons, fonts. */
const KEEP_PATHS = ["/assets/", "/icons/", "/excalidraw/"];
/** How long a launch waits for the network before using the saved app (slow or no signal). */
const NETWORK_WAIT_MS = 4000;

self.addEventListener("install", (e) => {
  self.skipWaiting();
  // The app's page, so the very first offline launch works.
  if (SAVES_SHELL) e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.add("/")).catch(() => {}));
});

self.addEventListener("activate", (e) =>
  e.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith(SHELL_PREFIX) && name !== SHELL_CACHE) await caches.delete(name);
      await self.clients.claim();
    })()
  )
);

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || e.request.method !== "GET") return;
  if (url.pathname.startsWith(MEDIA_PATH)) {
    e.respondWith(serveMedia(e.request, url, e.clientId || e.resultingClientId));
    return;
  }
  if (!SAVES_SHELL) return;
  if (e.request.mode === "navigate") e.respondWith(servePage(e.request));
  else if (KEEP_PATHS.some((p) => url.pathname.startsWith(p)) || url.pathname === "/manifest.webmanifest")
    e.respondWith(serveKept(e.request));
});

/** The app's page: the network's copy (saved for later), or the saved one when offline. */
async function servePage(request) {
  const cache = await caches.open(SHELL_CACHE);
  const network = fetch(request).then((res) => {
    // Every route is the same single-page app: keep it as "/".
    if (res.ok) void cache.put("/", res.clone());
    return res;
  });
  const quick = await Promise.race([
    network.catch(() => null),
    new Promise((resolve) => setTimeout(resolve, NETWORK_WAIT_MS, null)),
  ]);
  if (quick) return quick;
  // Offline or slow: the saved app, else keep waiting for the network.
  return (await cache.match("/")) ?? network;
}

/** A file that never changes: the saved copy, else the network's (then saved). */
async function serveKept(request) {
  const cache = await caches.open(SHELL_CACHE);
  const saved = await cache.match(request);
  if (saved) return saved;
  const res = await fetch(request);
  if (res.ok) await cache.put(request, res.clone());
  return res;
}

/** How long a page may take to download a missing file (large audio, slow network). */
const FETCH_TIMEOUT_MS = 120_000;

function askClient(client, name) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), FETCH_TIMEOUT_MS);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data === true);
    };
    client.postMessage({ type: "brewlm:need-media", name }, [channel.port2]);
  });
}

/** Ask the page that wants the file (else any open BrewLM window) to download it. */
async function fetchViaPage(clientId, name) {
  const asker = clientId ? await self.clients.get(clientId) : null;
  const others = await self.clients.matchAll({ type: "window" });
  for (const client of asker ? [asker, ...others.filter((c) => c.id !== asker.id)] : others) {
    if (await askClient(client, name)) return true;
  }
  return false;
}

async function serveMedia(request, url, clientId) {
  const cache = await caches.open(MEDIA_CACHE);
  // The query (?arrived, see lib/blobs.ts) only forces a reload; files are keyed by path.
  const key = url.origin + url.pathname;
  let hit = await cache.match(key);
  if (!hit && (await fetchViaPage(clientId, url.pathname.slice(MEDIA_PATH.length)))) hit = await cache.match(key);
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
