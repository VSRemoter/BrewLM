/**
 * /image on this computer. Two kinds of local image server:
 *  - Automatic1111's API (/sdapi/v1/…), which Forge, SD.Next and Draw Things
 *    also serve: draws (txt2img) and edits (img2img from the picture);
 *  - OpenAI's /v1/images/generations (LocalAI and others): draws only.
 * Which one a server speaks is found by asking it (detectImageServer) and
 * saved, so later pictures skip the check.
 *
 * Like the cloud path, a request carries only the prompt and, for an edit,
 * the one picture being changed. Requests go through the app's own HTTP
 * client, so servers need no CORS setup.
 */
import { platform } from "../platform";
import { localHeaders } from "./local";
import type { LocalImageApi, Settings } from "./types";

/** The server's root, without /v1 or /sdapi/v1 (A1111 paths hang off the root). */
export function imageServerRoot(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/sdapi\/v1$/i, "").replace(/\/v1$/i, "");
}

/** Where OpenAI-style image requests go: the address with /v1. */
function openAiBase(raw: string): string {
  const root = imageServerRoot(raw);
  return root ? `${root}/v1` : "";
}

/**
 * Pixel size for an aspect ratio: about a megapixel (or a quarter of one for
 * Stable Diffusion 1.5 checkpoints, which were trained at 512), in steps of
 * 64 as diffusion models need. Unreadable or extreme ratios fall back to square.
 */
export function sizeFor(ratio: string | undefined, model: string): { width: number; height: number } {
  const side = /1\.5|sd-?15|v1-5|\b512\b/i.test(model) ? 512 : 1024;
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratio ?? "");
  let r = m ? Number(m[1]) / Number(m[2]) : 1;
  if (!Number.isFinite(r) || r <= 0) r = 1;
  r = Math.min(4, Math.max(0.25, r));
  const snap = (v: number) => Math.max(64, Math.round(v / 64) * 64);
  return { width: snap(side * Math.sqrt(r)), height: snap(side / Math.sqrt(r)) };
}

/** A picture's aspect ratio as "w:h", for keeping an edited picture's shape. */
export function ratioOf(width: number, height: number): string | undefined {
  if (!(width > 0 && height > 0)) return undefined;
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = gcd(Math.round(width), Math.round(height));
  return `${Math.round(width) / g}:${Math.round(height) / g}`;
}

async function call(url: string, init: RequestInit & { connectTimeout?: number }, what: string): Promise<Response> {
  try {
    return await platform.fetch(url, { connectTimeout: 6000, ...init });
  } catch (e) {
    if (init.signal?.aborted || (e instanceof Error && e.name === "AbortError")) throw new DOMException("Aborted", "AbortError");
    throw new Error(`Couldn't reach your ${what} at ${new URL(url).origin}. Is it running?`);
  }
}

async function failure(res: Response, what: string): Promise<Error> {
  const raw = await res.text().catch(() => "");
  let detail = raw.slice(0, 200);
  try {
    const j = JSON.parse(raw) as { error?: { message?: string } | string; detail?: unknown; message?: string };
    const d = typeof j.error === "string" ? j.error : j.error?.message ?? j.message ?? j.detail;
    if (d) detail = typeof d === "string" ? d : JSON.stringify(d).slice(0, 200);
  } catch {
    /* keep raw */
  }
  if (res.status === 401 || res.status === 403) return new Error(`Your ${what} rejected the request. Check its API key.`);
  return new Error(`Your ${what} answered HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
}

export interface ImageServer {
  api: LocalImageApi;
  models: string[];
}

/** Ask the server which API it speaks, and what models it has. Throws a readable reason. */
export async function detectImageServer(s: Pick<Settings, "localImageBaseUrl" | "localImageKey">): Promise<ImageServer> {
  const root = imageServerRoot(s.localImageBaseUrl);
  if (!root) throw new Error("Set the image server's address first.");
  const headers = localHeaders(s.localImageKey);
  const sd = await call(`${root}/sdapi/v1/sd-models`, { headers }, "image server");
  if (sd.ok) {
    const list = (await sd.json().catch(() => [])) as { title?: string; model_name?: string }[];
    const models = Array.isArray(list) ? list.map((m) => m.title ?? m.model_name ?? "").filter(Boolean) : [];
    return { api: "a1111", models };
  }
  const oa = await call(`${openAiBase(s.localImageBaseUrl)}/models`, { headers }, "image server");
  if (oa.ok) {
    const json = (await oa.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
    const ids = (json?.data ?? []).map((m) => m?.id).filter((id): id is string => typeof id === "string");
    // LocalAI lists every model it has; image ones first.
    const imagey = (id: string) => /diffusion|sdxl|sd-?\d|flux|dreamshaper|image|dall|playground|kandinsky|pixart|sana|hidream/i.test(id);
    return { api: "openai", models: [...ids.filter(imagey), ...ids.filter((id) => !imagey(id))] };
  }
  if (sd.status === 401 || sd.status === 403 || oa.status === 401 || oa.status === 403)
    throw new Error("Your image server rejected the request. Check its API key.");
  throw new Error(
    `${root} doesn't look like an image server: it has neither Automatic1111's API (/sdapi/v1) nor OpenAI's (/v1/images). For Forge or A1111, start it with --api; in Draw Things, turn on its API server.`
  );
}

/** Whether pictures made on this server can be edited (A1111-style servers can; OpenAI-style ones only draw). */
export function localImageCanEdit(s: Pick<Settings, "localImageApi">): boolean {
  return s.localImageApi === "a1111";
}

export interface LocalImageOptions {
  prompt: string;
  aspectRatio?: string;
  /** The one picture being changed (data URI), for an edit or remix. */
  reference?: string;
  /** How far an edit may move from the picture: 0 = unchanged, 1 = ignore it. */
  strength?: number;
  n?: number;
  signal?: AbortSignal;
}

/** Images (data URIs) drawn on the local image server. */
export async function generateLocalImages(
  s: Pick<Settings, "localImageBaseUrl" | "localImageKey" | "localImageModel" | "localImageApi">,
  opts: LocalImageOptions,
  /** Called with the API once it's been found, so it can be saved. */
  onDetected?: (api: LocalImageApi) => void
): Promise<{ images: string[]; aspectRatio?: string }> {
  let api = s.localImageApi;
  if (!api) {
    api = (await detectImageServer(s)).api;
    onDetected?.(api);
  }
  const model = s.localImageModel.trim();
  const { width, height } = sizeFor(opts.aspectRatio, model);
  const headers = localHeaders(s.localImageKey);
  const n = Math.max(1, Math.min(4, opts.n ?? 1));
  const what = "image server";

  if (api === "a1111") {
    const root = imageServerRoot(s.localImageBaseUrl);
    const body: Record<string, unknown> = { prompt: opts.prompt, width, height, batch_size: n };
    // A1111 and Forge switch checkpoints this way; Draw Things reads "model".
    if (model) {
      body.override_settings = { sd_model_checkpoint: model };
      body.model = model;
    }
    if (opts.reference) {
      body.init_images = [opts.reference.slice(opts.reference.indexOf(",") + 1)];
      body.denoising_strength = opts.strength ?? 0.6;
    }
    // A cancel stops the server too, not just the wait.
    const stop = () => void call(`${root}/sdapi/v1/interrupt`, { method: "POST", headers }, what).catch(() => {});
    opts.signal?.addEventListener("abort", stop, { once: true });
    try {
      const res = await call(
        `${root}/sdapi/v1/${opts.reference ? "img2img" : "txt2img"}`,
        { method: "POST", headers, body: JSON.stringify(body), signal: opts.signal },
        what
      );
      if (!res.ok) throw await failure(res, what);
      const json = (await res.json()) as { images?: unknown[] };
      const images = (json.images ?? [])
        .filter((b): b is string => typeof b === "string" && b.length > 100)
        .slice(0, n) // some servers append extra images, such as a ControlNet map
        .map((b) => (b.startsWith("data:") ? b : `data:image/png;base64,${b}`));
      if (images.length === 0) throw new Error("Your image server returned no image.");
      return { images, aspectRatio: opts.aspectRatio };
    } finally {
      opts.signal?.removeEventListener("abort", stop);
    }
  }

  if (opts.reference) throw new Error("This image server can only draw new pictures, not edit them.");
  const res = await call(
    `${openAiBase(s.localImageBaseUrl)}/images/generations`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ ...(model ? { model } : {}), prompt: opts.prompt, n, size: `${width}x${height}`, response_format: "b64_json" }),
      signal: opts.signal,
    },
    what
  );
  if (!res.ok) throw await failure(res, what);
  const json = (await res.json()) as { data?: { b64_json?: unknown; url?: unknown }[] };
  const images: string[] = [];
  for (const item of json.data ?? []) {
    if (typeof item.b64_json === "string") images.push(`data:image/png;base64,${item.b64_json}`);
    else if (typeof item.url === "string" && item.url.startsWith("data:image/")) images.push(item.url);
    else if (typeof item.url === "string" && /^https?:\/\//.test(item.url)) {
      // LocalAI may answer with a link to the file it saved.
      const img = await call(item.url, { headers, signal: opts.signal }, what);
      if (img.ok) {
        const bytes = new Uint8Array(await img.arrayBuffer());
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        images.push(`data:${img.headers.get("content-type")?.split(";")[0] || "image/png"};base64,${btoa(bin)}`);
      }
    }
  }
  if (images.length === 0) throw new Error("Your image server returned no image.");
  return { images, aspectRatio: opts.aspectRatio };
}
