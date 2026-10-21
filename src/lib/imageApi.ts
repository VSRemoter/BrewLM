/**
 * OpenRouter Image API (`POST /api/v1/images`) — the /image command's backend.
 *
 * Unlike a chat call, the request carries ONLY the user's prompt (plus, for an
 * edit, the single picture being changed): no system prompt, no notebook
 * sources, no history. That keeps every picture priced as
 * just the image, and keeps it out of the chat model's context entirely.
 */
import type { StreamUsage } from "./llm";

const BASE = "https://openrouter.ai/api/v1";

interface ParamSpec {
  type: "enum" | "range" | "boolean";
  values?: string[];
  min?: number;
  max?: number;
}

/** model id → supported_parameters, fetched once per session (public endpoint). */
let modelSpecs: Promise<Map<string, Record<string, ParamSpec>>> | null = null;

function loadModelSpecs(): Promise<Map<string, Record<string, ParamSpec>>> {
  return (modelSpecs ??= fetch(`${BASE}/images/models`)
    .then((r) => (r.ok ? r.json() : { data: [] }))
    .then((json) => {
      const list: { id: string; supported_parameters?: Record<string, ParamSpec> }[] =
        Array.isArray(json) ? json : json.data ?? [];
      return new Map(list.map((m) => [m.id, m.supported_parameters ?? {}]));
    })
    .catch(() => {
      modelSpecs = null; // retry next time
      return new Map();
    }));
}

export interface ImageGenOptions {
  apiKey: string;
  model: string;
  prompt: string;
  /** e.g. "16:9"; dropped if the model doesn't list it. */
  aspectRatio?: string;
  /**
   * Reference images (data URIs) for an edit/remix. Only ever the one picture
   * being changed — never chat history or sources.
   */
  references?: string[];
  /** Images to request (clamped to the model's max; default 1). */
  n?: number;
  signal?: AbortSignal;
}

export interface ImageGenResult {
  /** data: URIs, one per generated image. */
  images: string[];
  usage: StreamUsage;
  /** Aspect ratio actually sent (undefined = model default). */
  aspectRatio?: string;
}

/** True when `model` is an OpenRouter Image API model (false if the list can't load). */
export async function isImageApiModel(model: string): Promise<boolean> {
  return (await loadModelSpecs()).has(model.trim());
}

/** Every Image API model id ([] if the list can't load). */
export async function listImageModels(): Promise<string[]> {
  return [...(await loadModelSpecs()).keys()];
}

/** Aspect ratios the model accepts, or null when unknown. */
export async function supportedAspectRatios(model: string): Promise<string[] | null> {
  const spec = (await loadModelSpecs()).get(model);
  return spec?.aspect_ratio?.values ?? null;
}

/** How many reference images the model accepts (0 = it can't edit images). */
export async function maxInputReferences(model: string): Promise<number> {
  return (await loadModelSpecs()).get(model.trim())?.input_references?.max ?? 0;
}

/** Largest `n` the model accepts in one request (1 when unknown). */
export async function maxImagesPerRequest(model: string): Promise<number> {
  return Math.max(1, (await loadModelSpecs()).get(model.trim())?.n?.max ?? 1);
}

/** True when the model refuses to run without a reference image (edit-only models). */
export async function requiresInputReference(model: string): Promise<boolean> {
  return ((await loadModelSpecs()).get(model.trim())?.input_references?.min ?? 0) > 0;
}

/**
 * A few image models that can edit (accept a reference image), preferred ones
 * first — for "this model can't edit" suggestions.
 */
export async function editCapableModels(limit = 3): Promise<string[]> {
  const specs = await loadModelSpecs();
  const preferred = ["google/gemini-3.1-flash-lite-image", "qwen/qwen-image-2.1-turbo", "openai/gpt-image-1-mini"];
  const capable = [...specs.entries()]
    .filter(([, sp]) => (sp.input_references?.max ?? 0) > 0 && (sp.input_references?.min ?? 0) === 0)
    .map(([id]) => id);
  return [...preferred.filter((id) => capable.includes(id)), ...capable.filter((id) => !preferred.includes(id))].slice(
    0,
    limit
  );
}

export async function generateImages(opts: ImageGenOptions): Promise<ImageGenResult> {
  const specs = await loadModelSpecs();
  const spec = specs.get(opts.model);
  if (specs.size > 0 && !spec) {
    throw new Error(
      `“${opts.model}” isn't an OpenRouter image model. Pick one in Settings → AI Model → Image model.`
    );
  }

  const nMax = spec?.n?.max ?? 1;
  const n = Math.max(1, Math.min(opts.n ?? 1, nMax));
  const body: Record<string, unknown> = { model: opts.model, prompt: opts.prompt, n };
  if (opts.references?.length) {
    const refMax = spec?.input_references?.max ?? 0;
    if (specs.size > 0 && refMax === 0) {
      throw new Error(`“${opts.model}” can't take a reference image, so it can't edit pictures.`);
    }
    body.input_references = opts.references
      .slice(0, Math.max(1, refMax))
      .map((url) => ({ type: "image_url", image_url: { url } }));
  }
  // Cheapest sensible tier: 1K when the model offers a resolution choice.
  const res = spec?.resolution?.values;
  if (res?.includes("1K")) body.resolution = "1K";
  let aspectRatio: string | undefined;
  if (opts.aspectRatio && spec?.aspect_ratio?.values?.includes(opts.aspectRatio)) {
    aspectRatio = opts.aspectRatio;
    body.aspect_ratio = aspectRatio;
  }

  const r = await fetch(`${BASE}/images`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!r.ok) {
    let detail = "";
    try {
      const j = await r.json();
      detail = j.error?.message ?? JSON.stringify(j);
    } catch {
      detail = await r.text().catch(() => "");
    }
    throw new Error(`Image request failed (${r.status}): ${detail || r.statusText}`);
  }
  const json = await r.json();
  const images: string[] = [];
  for (const item of json.data ?? []) {
    if (typeof item?.b64_json === "string") {
      images.push(`data:${item.media_type || "image/png"};base64,${item.b64_json}`);
    } else if (typeof item?.url === "string" && item.url.startsWith("data:image/")) {
      images.push(item.url);
    }
  }
  if (images.length === 0) throw new Error("The image model returned no image.");
  const u = json.usage ?? {};
  return {
    images,
    aspectRatio,
    usage: {
      input: u.prompt_tokens ?? u.input_tokens,
      output: u.completion_tokens ?? u.output_tokens,
      costUsd: typeof u.cost === "number" ? u.cost : undefined,
    },
  };
}
