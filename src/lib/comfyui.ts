/**
 * /image on ComfyUI. ComfyUI runs a workflow — a graph of nodes — rather than
 * a fixed "draw this" call: BrewLM sends one (POST /prompt), waits for it to
 * finish (GET /history/<id>), and fetches the pictures it saved (GET /view).
 *
 * Two kinds of workflow:
 *  - built in: the standard checkpoint graph (load checkpoint → encode the
 *    prompt → sample → decode → save), for single-file models such as SDXL;
 *  - the user's own, exported from ComfyUI with Workflow → Export (API). That
 *    is what makes newer models (Flux, Qwen-Image, HiDream…) work: their graph
 *    is whatever their model card says. BrewLM finds where the prompt, size,
 *    seed and (for edits) the picture go, and fills them in.
 */
import { platform } from "../platform";
import { localHeaders } from "./local";

/** One node of a workflow in ComfyUI's API format. Inputs are values or links: [node id, output index]. */
export interface ComfyNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}
export type ComfyWorkflow = Record<string, ComfyNode>;

/** Where BrewLM writes into a workflow. */
export interface WorkflowPlan {
  /** [node, input] pairs that take the prompt. */
  prompt: [string, string][];
  /** Nodes with width/height (empty-latent nodes). */
  size: string[];
  /** [node, input] pairs holding a seed, randomized for each picture. */
  seeds: [string, string][];
  /** LoadImage nodes: an edit puts the picture here. */
  loadImage: string[];
  /** Nodes with a denoise strength (samplers), set for an edit. */
  denoise: string[];
  /** Checkpoint loaders, which take the picked model. */
  checkpoint: string[];
}

/** The placeholder a user can type into their workflow's prompt box to say where the prompt goes. */
export const PROMPT_TOKEN = "{{prompt}}";

const isLink = (v: unknown): v is [string, number] => Array.isArray(v) && v.length === 2 && typeof v[1] === "number";

/** A workflow from what the user pasted or imported. Throws a readable reason. */
export function parseWorkflow(raw: string): ComfyWorkflow {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("That isn't a workflow file (it isn't JSON).");
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("That isn't a ComfyUI workflow.");
  const o = json as Record<string, unknown>;
  // The everyday save (Workflow → Save) is the editor's format, with nodes and links lists.
  if (Array.isArray(o.nodes) && Array.isArray(o.links))
    throw new Error("That's ComfyUI's regular save. In ComfyUI, use Workflow → Export (API) and import that file instead.");
  // Some tools wrap it: {"prompt": {...}}.
  const graph = (o.prompt && typeof o.prompt === "object" && !Array.isArray(o.prompt) ? o.prompt : o) as Record<string, unknown>;
  const nodes = Object.entries(graph).filter(
    ([, n]) => !!n && typeof n === "object" && typeof (n as ComfyNode).class_type === "string" && typeof (n as ComfyNode).inputs === "object"
  );
  if (nodes.length === 0) throw new Error("No ComfyUI nodes found in it. Export it with Workflow → Export (API).");
  return Object.fromEntries(nodes) as ComfyWorkflow;
}

/** String inputs that hold prompt text, by the names ComfyUI's text encoders use. */
const TEXT_INPUTS = ["text", "prompt", "t5xxl", "clip_l", "text_g", "text_l"];

/** Find where the prompt, size, seed and picture go. */
export function planWorkflow(wf: ComfyWorkflow): WorkflowPlan {
  const plan: WorkflowPlan = { prompt: [], size: [], seeds: [], loadImage: [], denoise: [], checkpoint: [] };
  for (const [id, node] of Object.entries(wf)) {
    const inp = node.inputs ?? {};
    for (const [k, v] of Object.entries(inp)) {
      if (typeof v === "string" && v.includes(PROMPT_TOKEN)) plan.prompt.push([id, k]);
      if ((k === "seed" || k === "noise_seed") && typeof v === "number") plan.seeds.push([id, k]);
    }
    if (typeof inp.width === "number" && typeof inp.height === "number" && /latent/i.test(node.class_type)) plan.size.push(id);
    if (node.class_type === "LoadImage") plan.loadImage.push(id);
    if (typeof inp.denoise === "number") plan.denoise.push(id);
    if (node.class_type === "CheckpointLoaderSimple" && typeof inp.ckpt_name === "string") plan.checkpoint.push(id);
  }
  if (plan.prompt.length) return plan;

  // No placeholder: follow each sampler's positive conditioning back to the node that holds text.
  const textNode = (start: unknown, depth = 0): string | null => {
    if (!isLink(start) || depth > 6) return null;
    const node = wf[String(start[0])];
    if (!node) return null;
    if (TEXT_INPUTS.some((k) => typeof node.inputs[k] === "string")) return String(start[0]);
    for (const k of ["conditioning", "positive", "guider", "conditioning_to", "conditioning_1"])
      if (k in node.inputs) {
        const found = textNode(node.inputs[k], depth + 1);
        if (found) return found;
      }
    return null;
  };
  // Start only from the positive side: a sampler's "positive", a sampler's "guider", or a
  // guider's own "conditioning" (Flux's BasicGuider). Never "negative", so its text stays put.
  const found = new Set<string>();
  for (const node of Object.values(wf)) {
    const starts = ["positive", "guider", ...(/guider/i.test(node.class_type) ? ["conditioning"] : [])];
    for (const k of starts) {
      const id = k in node.inputs ? textNode(node.inputs[k]) : null;
      if (id) found.add(id);
    }
  }
  // A graph with a single text encoder: that's the prompt.
  if (found.size === 0) {
    const encoders = Object.entries(wf).filter(([, n]) => TEXT_INPUTS.some((k) => typeof n.inputs[k] === "string"));
    if (encoders.length === 1) found.add(encoders[0][0]);
  }
  for (const id of found)
    for (const k of TEXT_INPUTS) if (typeof wf[id].inputs[k] === "string") plan.prompt.push([id, k]);
  return plan;
}

/** Problems that stop a workflow from drawing; [] when it can. */
export function workflowProblems(plan: WorkflowPlan): string[] {
  const out: string[] = [];
  if (!plan.prompt.length)
    out.push(`BrewLM can't tell where the prompt goes. In ComfyUI, type ${PROMPT_TOKEN} in the prompt box, then export it again.`);
  return out;
}

export interface FillOptions {
  prompt: string;
  width: number;
  height: number;
  n: number;
  /** The uploaded picture's name on the server, for an edit. */
  image?: string;
  /** Edit strength: 0 = unchanged, 1 = ignore the picture. */
  strength?: number;
  /** Checkpoint for loaders (built-in workflow). */
  model?: string;
  /** Seed source, for tests. */
  random?: () => number;
}

/** A copy of the workflow with this request's values filled in. */
export function fillWorkflow(wf: ComfyWorkflow, plan: WorkflowPlan, o: FillOptions): ComfyWorkflow {
  const out = JSON.parse(JSON.stringify(wf)) as ComfyWorkflow;
  const random = o.random ?? Math.random;
  for (const [id, k] of plan.prompt) {
    const v = out[id].inputs[k] as string;
    out[id].inputs[k] = v.includes(PROMPT_TOKEN) ? v.split(PROMPT_TOKEN).join(o.prompt) : o.prompt;
  }
  for (const id of plan.size) {
    out[id].inputs.width = o.width;
    out[id].inputs.height = o.height;
    if ("batch_size" in out[id].inputs) out[id].inputs.batch_size = o.n;
  }
  for (const [id, k] of plan.seeds) out[id].inputs[k] = Math.floor(random() * 2 ** 48);
  if (o.image) {
    for (const id of plan.loadImage) out[id].inputs.image = o.image;
    if (o.strength !== undefined) for (const id of plan.denoise) out[id].inputs.denoise = o.strength;
  }
  if (o.model) for (const id of plan.checkpoint) out[id].inputs.ckpt_name = o.model;
  return out;
}

/**
 * The built-in graph for single-file checkpoints, drawing or (with a picture)
 * editing. Steps and guidance suit SDXL-class models; Flux and few-step
 * "turbo" checkpoints get the settings they need.
 */
export function builtInWorkflow(model: string, edit: boolean): ComfyWorkflow {
  const flux = /flux/i.test(model);
  const fast = /turbo|lightning|schnell|hyper|lcm/i.test(model);
  const steps = fast ? 6 : flux ? 20 : 25;
  const cfg = flux ? 1 : fast ? 1.5 : 6.5;
  const wf: ComfyWorkflow = {
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: model } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: PROMPT_TOKEN, clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["4", 1] } },
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: 0,
        steps,
        cfg,
        sampler_name: "euler",
        scheduler: flux ? "simple" : "normal",
        denoise: 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: edit ? ["11", 0] : ["5", 0],
      },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "BrewLM", images: ["8", 0] } },
  };
  if (edit) {
    wf["10"] = { class_type: "LoadImage", inputs: { image: "" } };
    wf["11"] = { class_type: "VAEEncode", inputs: { pixels: ["10", 0], vae: ["4", 2] } };
  } else {
    wf["5"] = { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } };
  }
  return wf;
}

/* --------------------------------- server --------------------------------- */

interface Server {
  root: string;
  key: string;
}

async function call(url: string, init: RequestInit & { connectTimeout?: number } = {}): Promise<Response> {
  try {
    return await platform.fetch(url, { connectTimeout: 6000, ...init });
  } catch (e) {
    if (init.signal?.aborted || (e instanceof Error && e.name === "AbortError")) throw new DOMException("Aborted", "AbortError");
    throw new Error(`Couldn't reach ComfyUI at ${new URL(url).origin}. Is it running?`);
  }
}

/** True when the address is a ComfyUI server (GET /system_stats). */
export async function isComfyUI(s: Server): Promise<boolean> {
  try {
    const res = await platform.fetch(`${s.root}/system_stats`, { headers: localHeaders(s.key), connectTimeout: 3000 });
    if (!res.ok) return false;
    const j = (await res.json().catch(() => null)) as { system?: unknown; devices?: unknown } | null;
    return !!j && typeof j.system === "object" && Array.isArray(j.devices);
  } catch {
    return false;
  }
}

/** Options of a combo input from /object_info: [[...options], {...}] or ["COMBO", {options: [...]}]. */
export function comboOptions(spec: unknown): string[] {
  if (!Array.isArray(spec)) return [];
  if (Array.isArray(spec[0])) return spec[0].filter((x): x is string => typeof x === "string");
  const opts = (spec[1] as { options?: unknown } | undefined)?.options;
  return Array.isArray(opts) ? opts.filter((x): x is string => typeof x === "string") : [];
}

/** The checkpoints ComfyUI has, for the built-in workflow. */
export async function comfyCheckpoints(s: Server): Promise<string[]> {
  try {
    const res = await call(`${s.root}/object_info/CheckpointLoaderSimple`, { headers: localHeaders(s.key) });
    if (!res.ok) return [];
    const j = (await res.json()) as { CheckpointLoaderSimple?: { input?: { required?: { ckpt_name?: unknown } } } };
    return comboOptions(j.CheckpointLoaderSimple?.input?.required?.ckpt_name);
  } catch {
    return [];
  }
}

/** ComfyUI's refusal, in words: the error and the first node problem. */
async function promptError(res: Response): Promise<Error> {
  const raw = await res.text().catch(() => "");
  try {
    const j = JSON.parse(raw) as {
      error?: { message?: string; details?: string };
      node_errors?: Record<string, { class_type?: string; errors?: { message?: string; details?: string }[] }>;
    };
    const node = Object.values(j.node_errors ?? {})[0];
    const why = node?.errors?.[0];
    const detail = why ? ` (${node?.class_type ?? "a node"}: ${why.message ?? ""}${why.details ? ` — ${why.details}` : ""})` : "";
    if (j.error?.message) return new Error(`ComfyUI refused the workflow: ${j.error.message}${detail}`);
  } catch {
    /* plain text */
  }
  if (res.status === 401 || res.status === 403) return new Error("ComfyUI rejected the request. Check its API key.");
  return new Error(`ComfyUI answered HTTP ${res.status}${raw ? `: ${raw.slice(0, 200)}` : ""}`);
}

/** Put the picture being edited on the server; its name for LoadImage. */
async function upload(s: Server, dataUri: string, signal?: AbortSignal): Promise<string> {
  const mime = /^data:([^;,]+)/.exec(dataUri)?.[1] ?? "image/png";
  const bin = atob(dataUri.slice(dataUri.indexOf(",") + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: mime }), `brewlm-${Date.now()}.${mime.split("/")[1] || "png"}`);
  form.append("overwrite", "true");
  const headers = localHeaders(s.key);
  delete headers["Content-Type"]; // the form sets its own boundary
  const res = await call(`${s.root}/upload/image`, { method: "POST", headers, body: form, signal });
  if (!res.ok) throw await promptError(res);
  const j = (await res.json()) as { name?: string; subfolder?: string };
  if (!j.name) throw new Error("ComfyUI didn't take the picture.");
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

interface HistoryImage {
  filename: string;
  subfolder?: string;
  type?: string;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });

export interface ComfyRun {
  prompt: string;
  width: number;
  height: number;
  n: number;
  /** Picture to edit (data URI). */
  reference?: string;
  strength?: number;
  /** Checkpoint for the built-in workflow ("" = the first one ComfyUI has). */
  model: string;
  /** The user's workflow in API format ("" = built in). */
  workflow: string;
  signal?: AbortSignal;
  /** Wait between status checks, for tests. */
  pollMs?: number;
}

/** Run a workflow on ComfyUI and return its pictures as data URIs. */
export async function runComfyWorkflow(s: Server, run: ComfyRun): Promise<string[]> {
  const headers = localHeaders(s.key);
  const edit = !!run.reference;
  let wf: ComfyWorkflow;
  let model = run.model.trim();
  if (run.workflow.trim()) {
    wf = parseWorkflow(run.workflow);
  } else {
    if (!model) model = (await comfyCheckpoints(s))[0] ?? "";
    if (!model)
      throw new Error(
        "ComfyUI has no checkpoint models for the built-in workflow. Add one to its models/checkpoints folder, or import your own workflow in Settings → Local Models → Pictures."
      );
    wf = builtInWorkflow(model, edit);
  }
  const plan = planWorkflow(wf);
  const problems = workflowProblems(plan);
  if (problems.length) throw new Error(problems[0]);
  if (edit && !plan.loadImage.length)
    throw new Error("Your ComfyUI workflow can only draw new pictures: it has no Load Image node to edit one.");

  const image = edit ? await upload(s, run.reference!, run.signal) : undefined;
  const graph = fillWorkflow(wf, plan, {
    prompt: run.prompt,
    width: run.width,
    height: run.height,
    n: run.n,
    image,
    strength: run.strength ?? 0.6,
    model: run.workflow.trim() ? undefined : model,
  });

  const queued = await call(`${s.root}/prompt`, {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: graph, client_id: "brewlm" }),
    signal: run.signal,
  });
  if (!queued.ok) throw await promptError(queued);
  const id = ((await queued.json()) as { prompt_id?: string }).prompt_id;
  if (!id) throw new Error("ComfyUI didn't queue the picture.");

  // A cancel stops ComfyUI too: drop it from the queue, or interrupt it if it's running.
  const stop = () => {
    void call(`${s.root}/queue`, { method: "POST", headers, body: JSON.stringify({ delete: [id] }) }).catch(() => {});
    void call(`${s.root}/interrupt`, { method: "POST", headers }).catch(() => {});
  };
  run.signal?.addEventListener("abort", stop, { once: true });
  try {
    for (;;) {
      await sleep(run.pollMs ?? 800, run.signal);
      const res = await call(`${s.root}/history/${encodeURIComponent(id)}`, { headers, signal: run.signal });
      if (!res.ok) continue;
      const entry = ((await res.json().catch(() => ({}))) as Record<string, unknown>)[id] as
        | {
            outputs?: Record<string, { images?: HistoryImage[] }>;
            status?: { status_str?: string; completed?: boolean; messages?: [string, { exception_message?: string; node_type?: string }][] };
          }
        | undefined;
      if (!entry) continue; // still queued or running
      if (entry.status?.status_str === "error") {
        const err = entry.status.messages?.find((m) => m[0] === "execution_error")?.[1];
        throw new Error(
          `ComfyUI couldn't finish the picture${err?.node_type ? ` (${err.node_type})` : ""}${err?.exception_message ? `: ${err.exception_message.trim()}` : "."}`
        );
      }
      const all = Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? []);
      // Saved pictures, else previews (a workflow that only previews still shows something).
      const saved = all.filter((i) => i.type === "output");
      const pick = (saved.length ? saved : all).slice(0, run.n);
      if (!pick.length) {
        if (entry.status?.completed) throw new Error("Your ComfyUI workflow finished without a picture. Does it end in a Save Image node?");
        continue;
      }
      return await Promise.all(pick.map((img) => fetchImage(s, img, run.signal)));
    }
  } finally {
    run.signal?.removeEventListener("abort", stop);
  }
}

async function fetchImage(s: Server, img: HistoryImage, signal?: AbortSignal): Promise<string> {
  const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? "", type: img.type ?? "output" });
  const res = await call(`${s.root}/view?${q}`, { headers: localHeaders(s.key), signal });
  if (!res.ok) throw new Error(`ComfyUI made the picture but wouldn't send it (HTTP ${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${res.headers.get("content-type")?.split(";")[0] || "image/png"};base64,${btoa(bin)}`;
}
