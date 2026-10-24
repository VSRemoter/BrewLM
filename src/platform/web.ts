/** The browser build's platform — the phone app (see types.ts). */
import type { FileFilter, Platform, SqlDb, SqlResult } from "./types";
import type { DbRequest } from "./webDbWorker";

/* -------------------------------- database ------------------------------- */

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function call<T>(req: DbRequest): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL("./webDbWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const w = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      if (e.data.error !== undefined) w?.reject(new Error(e.data.error));
      else w?.resolve(e.data.result);
    };
  }
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker!.postMessage({ id, req });
  });
}

async function openDb(): Promise<SqlDb> {
  await call({ op: "open" });
  return {
    execute: (sql, bind) => call<SqlResult>({ op: "execute", sql, bind }),
    select: <T,>(sql: string, bind?: unknown[]) => call<T>({ op: "select", sql, bind }),
    close: () => call({ op: "close" }),
  };
}

/* ---------------------------------- media --------------------------------- */

// Files live in Cache Storage under /_media/<name>; public/sw.js answers those
// URLs (with byte ranges, which Safari needs to play audio).
const MEDIA_CACHE = "brewlm-media";
const MEDIA_PATH = "/_media/";
const BLOB_PREFIX = "brewblob:";
const NAME_RE = /^[0-9a-f]{64}\.[a-z0-9]{1,5}$/;

const MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  avif: "image/avif",
  heic: "image/heic",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
  weba: "audio/webm",
  flac: "audio/flac",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  pdf: "application/pdf",
  md: "text/markdown",
  csv: "text/csv",
};
const mimeFor = (ext: string) => MIME[ext] ?? "application/octet-stream";

const mediaUrl = (name: string) => `${MEDIA_PATH}${name}`;
const stripPrefix = (n: string) => (n.startsWith(BLOB_PREFIX) ? n.slice(BLOB_PREFIX.length) : n);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function storedNames(cache: Cache): Promise<Set<string>> {
  return new Set((await cache.keys()).map((r) => new URL(r.url).pathname.slice(MEDIA_PATH.length)));
}

const blobs: Platform["blobs"] = {
  async put(bytes, ext) {
    const e = ext.trim().replace(/^\./, "").toLowerCase();
    const name = `${await sha256Hex(bytes)}.${e}`;
    if (!NAME_RE.test(name)) throw new Error(`bad blob extension: ${JSON.stringify(ext)}`);
    const cache = await caches.open(MEDIA_CACHE);
    if (!(await cache.match(mediaUrl(name))))
      await cache.put(
        mediaUrl(name),
        new Response(bytes as BodyInit, {
          headers: {
            "content-type": mimeFor(e),
            "content-length": String(bytes.length),
            "x-stored-at": String(Date.now()),
          },
        })
      );
    return BLOB_PREFIX + name;
  },
  url: mediaUrl,
  async missing(names) {
    const have = await storedNames(await caches.open(MEDIA_CACHE));
    return names.map(stripPrefix).filter((n) => NAME_RE.test(n) && !have.has(n));
  },
  async gc(keep, graceMs) {
    const cache = await caches.open(MEDIA_CACHE);
    const kept = new Set(keep.map(stripPrefix));
    const cutoff = Date.now() - graceMs;
    let removed = 0;
    let freed = 0;
    for (const req of await cache.keys()) {
      const name = new URL(req.url).pathname.slice(MEDIA_PATH.length);
      if (kept.has(name)) continue;
      const res = await cache.match(req);
      if (Number(res?.headers.get("x-stored-at") ?? 0) > cutoff) continue;
      if (await cache.delete(req)) {
        removed++;
        freed += Number(res?.headers.get("content-length") ?? 0);
      }
    }
    return { removed, freed_bytes: freed };
  },
  onMissing: (fetch) => void (fetchMissing = fetch),
};

/** Set by Sync: downloads a file this device doesn't have yet. */
let fetchMissing: ((name: string) => Promise<boolean>) | null = null;

/** The service worker asks for files it can't find (public/sw.js); answer through the message's port. */
function answerMediaRequests(): void {
  navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
    if (e.data?.type !== "brewlm:need-media" || !e.ports[0]) return;
    const name = String(e.data.name ?? "");
    const port = e.ports[0];
    const fetch = fetchMissing;
    (NAME_RE.test(name) && fetch ? fetch(name) : Promise.resolve(false)).then(
      (ok) => port.postMessage(ok),
      () => port.postMessage(false)
    );
  });
  navigator.serviceWorker.startMessages();
}

/* --------------------------------- files --------------------------------- */

function acceptFor(filters?: FileFilter[]): string {
  return (filters ?? []).flatMap((f) => f.extensions.map((e) => `.${e}`)).join(",");
}

/* -------------------------------- platform ------------------------------- */

const KV_PREFIX = "brewlm:";

let readyPromise: Promise<void> | null = null;

/** Register the media service worker and wait until it controls this page. */
async function ready(): Promise<void> {
  // Ask the browser not to evict BrewLM's storage under pressure (best effort).
  void navigator.storage?.persist?.().catch(() => {});
  if (!("serviceWorker" in navigator)) throw new Error("This browser can't run BrewLM (no service workers).");
  answerMediaRequests();
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  if (navigator.serviceWorker.controller) return;
  // First visit: the worker claims the page as it activates.
  await new Promise<void>((resolve) => {
    navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
    setTimeout(resolve, 3000);
  });
}

export const platform: Platform = {
  kind: "web",
  ready: () => (readyPromise ??= ready()),

  openDb,
  fetch: (url, init) => {
    const { connectTimeout: _ignored, ...rest } = init ?? {};
    return fetch(url, rest);
  },
  openUrl: async (url) => void window.open(url, "_blank", "noopener"),
  appVersion: async () => __APP_VERSION__,

  async saveFile({ defaultName, data }) {
    const ext = defaultName.split(".").pop()?.toLowerCase() ?? "";
    const blob = new Blob([data as BlobPart], { type: mimeFor(ext) });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = defaultName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    return defaultName;
  },
  pickFile({ filters }) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = acceptFor(filters);
      input.onchange = async () => {
        const file = input.files?.[0];
        resolve(file ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null);
      };
      input.oncancel = () => resolve(null);
      input.click();
    });
  },

  kv: {
    async get<T>(key: string) {
      const v = localStorage.getItem(KV_PREFIX + key);
      return v === null ? undefined : (JSON.parse(v) as T);
    },
    set: async (key, value) => localStorage.setItem(KV_PREFIX + key, JSON.stringify(value)),
    delete: async (key) => localStorage.removeItem(KV_PREFIX + key),
  },

  blobs,

  sync: {
    apply: (deviceId, changes) => call({ op: "apply", deviceId, changes }),
    markPushed: (pushed) => call({ op: "markPushed", pushed }),
    // The deployed app syncs with sync.brewlm.com; `npm run dev:web` only when
    // VITE_SYNC_URL names a server (as BREWLM_SYNC_URL does for desktop dev builds).
    config: async () => {
      const url =
        (import.meta.env.VITE_SYNC_URL as string | undefined) ||
        (import.meta.env.PROD ? "https://sync.brewlm.com" : undefined);
      if (!url) return null;
      return {
        url,
        token: import.meta.env.VITE_SYNC_TOKEN as string | undefined,
        vault: (import.meta.env.VITE_SYNC_VAULT as string | undefined) ?? "dev",
      };
    },
    // sync.ts already logs to the console; there's no launching terminal here.
    log: () => {},
  },
};
