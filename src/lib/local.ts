/**
 * Local / self-hosted models: any OpenAI-compatible server the user runs
 * (Ollama, LM Studio, llama.cpp, Jan, vLLM…). Requests go through the Tauri
 * HTTP plugin — i.e. the app's Rust backend — so servers need no CORS setup
 * and nothing is routed through a third party.
 *
 * Also owns the context budget: local models hold far less text than cloud
 * ones, so prompts are sized from the user's chosen context window.
 */
import { platform } from "../platform";
import { getSetting } from "./db";
import type { Settings } from "./types";

export interface LocalServer {
  baseUrl: string;
  key: string;
  context: number;
}

/**
 * Tidy what the user typed into a base URL: adds http://, drops trailing
 * slashes, and appends /v1 when only host:port was given (all three presets
 * serve the OpenAI API under /v1).
 */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  try {
    const u = new URL(url);
    if (u.pathname === "" || u.pathname === "/") url = `${url}/v1`;
  } catch {
    /* leave as typed; the connection test reports the problem */
  }
  return url;
}

/** Fresh read of the local server config (settings can change mid-session). */
export async function loadLocalServer(): Promise<LocalServer> {
  const [baseUrl, key, context] = await Promise.all([
    getSetting("localBaseUrl"),
    getSetting("localKey"),
    getSetting("localContext"),
  ]);
  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    key,
    context: parseLocalContext(context),
  };
}

/** The stored context-window choice: a size in tokens, or AUTO_CONTEXT ("" and junk read as Automatic). */
export function parseLocalContext(raw: string): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= MIN_CONTEXT ? n : AUTO_CONTEXT;
}

export function localHeaders(key: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (key) h.Authorization = `Bearer ${key}`;
  return h;
}

/** Embedding-only models can't chat — keep them out of the chat model list. */
export function isEmbeddingModel(id: string): boolean {
  return /embed|bge-|e5-|minilm|nomic-embed|gte-/i.test(id);
}

/**
 * Likely able to read images, judging by the name (Ollama and LM Studio don't
 * say over the OpenAI API). Only used to sort and pre-pick; the Test button
 * in Settings → Local models is the real check.
 */
export function isVisionModel(id: string): boolean {
  return /vision|[-_.:]vl\b|vl[-_.:]|llava|bakllava|gemma-?3|gemma-?4|minicpm-?v|pixtral|moondream|internvl|smolvlm|granite.*vision|llama-?4|mistral-small-?3\.[12]|qwen\d?(\.\d)?-?omni/i.test(
    id
  );
}

/** Model ids the server reports at GET {base}/models. Throws with a readable reason. */
export async function listLocalModels(server?: Pick<LocalServer, "baseUrl" | "key">, connectTimeout = 4000): Promise<string[]> {
  const s = server ?? (await loadLocalServer());
  const base = normalizeBaseUrl(s.baseUrl);
  if (!base) return [];
  let res: Response;
  try {
    res = await platform.fetch(`${base}/models`, {
      headers: localHeaders(s.key),
      connectTimeout,
    });
  } catch {
    throw new Error(`Couldn't reach ${base}. Is the server running?`);
  }
  if (res.status === 401 || res.status === 403)
    throw new Error("The server rejected the request. Check the API key.");
  if (!res.ok) throw new Error(`The server answered ${res.status} at ${base}/models. Check the address ends in /v1.`);
  const json = (await res.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
  const ids = (json?.data ?? []).map((m) => m?.id).filter((id): id is string => typeof id === "string");
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/* ------------------------------ local speech ------------------------------ */

/** Starter voices for Local: Kokoro's (af_ = American female, bm_ = British male…). */
export const LOCAL_TTS_VOICES = ["af_heart", "af_bella", "am_michael", "am_adam", "bf_emma", "bm_george"];

/**
 * The voices the two hosts use on a local server. Picks the server has are
 * kept; a missing or unknown one (say "nova", left from OpenAI) is replaced by
 * a server voice the other host isn't using, so the hosts never sound alike by
 * accident. With no voice list from the server, the picks go as they are
 * ("" = the server's default).
 */
export function localHostVoices(
  picked: { Alex: string; Sam: string },
  served: string[] | null
): { Alex: string; Sam: string } {
  if (!served?.length) return picked;
  const ok = (v: string) => (v && served.includes(v) ? v : "");
  const other = (avoid: string) =>
    LOCAL_TTS_VOICES.find((v) => served.includes(v) && v !== avoid) ?? served.find((v) => v !== avoid) ?? served[0];
  let alex = ok(picked.Alex);
  let sam = ok(picked.Sam);
  if (!alex) alex = other(sam);
  if (!sam) sam = other(alex);
  return { Alex: alex, Sam: sam };
}

/** Speech models among a server's models (Speaches also lists Whisper; LocalAI lists everything). */
export function isSpeechModel(id: string): boolean {
  return /kokoro|tts|piper|orpheus|xtts|chatterbox|melo|outetts|kitten|parler|bark|zonos|csm|dia-|f5|vits|sesame/i.test(id) && !isEmbeddingModel(id) && !/whisper|transcri|stt/i.test(id);
}

/** Speech-to-text models among a server's models (Speaches lists its TTS models too). */
export function isTranscribeModel(id: string): boolean {
  return /whisper|transcri|parakeet|canary|moonshine|sensevoice|stt|voxtral|distil/i.test(id) && !isEmbeddingModel(id);
}

/** Voice ids out of the shapes servers use: ["af_heart"], {voices: [...]}, {data: [{id}]}… */
export function parseVoiceList(json: unknown): string[] {
  const obj = json as { voices?: unknown; data?: unknown } | null;
  const raw: unknown[] = Array.isArray(json) ? json : Array.isArray(obj?.voices) ? obj.voices : Array.isArray(obj?.data) ? obj.data : [];
  const ids = raw
    .map((v) => {
      if (typeof v === "string") return v;
      const o = v as { id?: unknown; voice_id?: unknown; name?: unknown } | null;
      const id = o?.id ?? o?.voice_id ?? o?.name;
      return typeof id === "string" ? id : "";
    })
    .filter((id) => id.trim());
  return [...new Set(ids)];
}

/**
 * Voices the speech server offers, or null when it doesn't say (not every
 * server has a voice list: Kokoro-FastAPI does at /audio/voices).
 */
export async function listLocalVoices(server: { baseUrl: string; key: string }): Promise<string[] | null> {
  const base = normalizeBaseUrl(server.baseUrl);
  if (!base) return null;
  for (const path of ["/audio/voices", "/audio/speech/voices"]) {
    try {
      const res = await platform.fetch(`${base}${path}`, { headers: localHeaders(server.key), connectTimeout: 4000 });
      if (!res.ok) continue;
      const voices = parseVoiceList(await res.json().catch(() => null));
      if (voices.length) return voices;
    } catch {
      return null; // unreachable: no point trying the other path
    }
  }
  return null;
}

/** Where the popular local runners listen by default. */
/**
 * Where the popular local runners listen by default. Several share a port
 * (8080: llama.cpp, Strata, mlx_lm.server, LocalAI, llamafile; 8000: vLLM,
 * Speaches), so the label here is only a fallback — detection asks the server
 * what it is (see engineName).
 */
const DETECT_TARGETS: { label: string; port: number; path?: string }[] = [
  { label: "Ollama", port: 11434 },
  { label: "LM Studio", port: 1234 },
  { label: "Server on port 8080", port: 8080 },
  { label: "Jan", port: 1337 },
  { label: "vLLM or Speaches", port: 8000 },
  { label: "KoboldCpp", port: 5001 },
  { label: "TabbyAPI", port: 5000 },
  { label: "SGLang", port: 30000 },
  { label: "GPT4All", port: 4891 },
  { label: "MLX Omni Server", port: 10240 },
  { label: "Docker Model Runner", port: 12434, path: "/engines/v1" },
];

export interface FoundServer {
  label: string;
  baseUrl: string;
  models: string[];
}

/** Local servers answering on their usual ports, checked side by side and named by what they say they are. */
export async function detectLocalServers(): Promise<FoundServer[]> {
  const found = await Promise.all(
    DETECT_TARGETS.map(async ({ label, port, path = "/v1" }) => {
      const baseUrl = `http://localhost:${port}${path}`;
      try {
        const models = await listLocalModels({ baseUrl, key: "" }, 1500);
        return { label: (await engineName(baseUrl, models)) ?? label, baseUrl, models };
      } catch {
        return null;
      }
    })
  );
  return found.filter((f): f is FoundServer => f !== null);
}

/** Which engine is answering, from what it reports about one of its models; null when it doesn't say. */
async function engineName(baseUrl: string, models: string[]): Promise<string | null> {
  if (!models.length) return null;
  return (await readServerContext({ baseUrl, key: "" }, models[0]).catch(() => null))?.server ?? null;
}

/* ------------------------------ context budget ------------------------------ */

/** How much of each kind of text one request may carry (characters, except maxOutput). */
export interface ContextBudget {
  /** Retrieved source excerpts. */
  sources: number;
  /** Per-source cap when excerpts aren't available. */
  perSource: number;
  constitution: number;
  /** @-mentioned material. */
  mentions: number;
  /** Earlier chat turns. */
  history: number;
  /** Text per condense call in the whole-notebook map-reduce pass. */
  condenseGroup: number;
  /** Max tokens the model may generate. */
  maxOutput: number;
}

/** Cloud models: generous windows, tuned for cost rather than fit. */
export const CLOUD_BUDGET: ContextBudget = {
  // ~57k tokens: enough to carry whole lessons/sections, not just a few passages.
  sources: 200_000,
  perSource: 6000,
  constitution: 6000,
  mentions: 16_000,
  history: 24_000,
  condenseGroup: 20_000,
  maxOutput: 4096,
};

/** ~3.5 characters per token is a safe average for English prose. */
const CHARS_PER_TOKEN = 3.5;
/** Rules, persona and formatting instructions in every system prompt. */
const PROMPT_OVERHEAD_TOKENS = 1200;

/**
 * Size a request to the model's context window. A quarter of it is reserved
 * for the answer; of the rest, ~60% goes to sources, ~25% to history.
 * Never exceeds the cloud budget, even on 128k-token models.
 */
export function budgetForContext(contextTokens: number): ContextBudget {
  const maxOutput = Math.max(512, Math.min(4096, Math.floor(contextTokens / 4)));
  const promptChars = Math.max(2000, (contextTokens - maxOutput - PROMPT_OVERHEAD_TOKENS) * CHARS_PER_TOKEN);
  const cap = (v: number, cloud: number) => Math.floor(Math.min(v, cloud));
  return {
    sources: cap(promptChars * 0.6, CLOUD_BUDGET.sources),
    perSource: cap(promptChars * 0.2, CLOUD_BUDGET.perSource),
    constitution: cap(promptChars * 0.15, CLOUD_BUDGET.constitution),
    mentions: cap(promptChars * 0.4, CLOUD_BUDGET.mentions),
    history: cap(promptChars * 0.25, CLOUD_BUDGET.history),
    condenseGroup: cap(promptChars * 0.75, CLOUD_BUDGET.condenseGroup),
    maxOutput,
  };
}

export function contextBudget(s: Pick<Settings, "provider" | "localContext" | "localBaseUrl" | "model">): ContextBudget {
  return s.provider === "local" ? budgetForContext(effectiveContext(s)) : CLOUD_BUDGET;
}

/* ------------------------- the server's real window ------------------------- */
/*
 * A server can hold a model with a smaller window than the user picked here.
 * Ollama is the usual case: it loads models with 4,096 tokens unless
 * OLLAMA_CONTEXT_LENGTH says otherwise, ignores any size sent over its OpenAI
 * API, and silently drops whatever doesn't fit — so answers quietly lose
 * source text. BrewLM asks the server what it actually loaded and never sends
 * more than that.
 */

/** Settings value for "use the size the server reports". */
export const AUTO_CONTEXT = 0;
/** Smallest window BrewLM sizes requests for. */
const MIN_CONTEXT = 2048;
/** Automatic, when the server doesn't say. */
const FALLBACK_CONTEXT = 8192;

export type ContextServer = "Ollama" | "LM Studio" | "llama.cpp" | "vLLM" | "SGLang" | "Strata" | "KoboldCpp" | "TabbyAPI";

/** What a server says about one model's window. */
export interface ServerContext {
  server: ContextServer;
  /** Tokens the loaded model can hold; null while it isn't loaded. */
  loaded: number | null;
  /** The model's own maximum, when the server says. */
  max: number | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null);
/** Ollama treats "llama3" and "llama3:latest" as one model. */
const ollamaName = (id: string) => id.trim().replace(/:latest$/, "");

/** Ollama GET /api/ps: the window of the model if it's loaded (null if it isn't), or undefined when this isn't Ollama's answer. */
export function parseOllamaPs(json: unknown, model: string): number | null | undefined {
  const list = (json as { models?: unknown } | null)?.models;
  if (!Array.isArray(list)) return undefined;
  const hit = list.find((m) => {
    const o = m as { name?: unknown; model?: unknown };
    return [o.name, o.model].some((n) => typeof n === "string" && ollamaName(n) === ollamaName(model));
  }) as { context_length?: unknown } | undefined;
  return hit ? num(hit.context_length) : null;
}

/** Ollama POST /api/show: the model's trained maximum (model_info["<arch>.context_length"]). */
export function parseOllamaShow(json: unknown): number | null {
  const info = (json as { model_info?: Record<string, unknown> } | null)?.model_info;
  if (!info || typeof info !== "object") return null;
  for (const [k, v] of Object.entries(info)) if (k.endsWith(".context_length")) return num(v);
  return null;
}

/** LM Studio GET /api/v1/models (or the older /api/v0/models), or null when the model isn't listed. */
export function parseLmStudioModels(json: unknown, model: string): { loaded: number | null; max: number | null } | null {
  const o = json as { models?: unknown; data?: unknown } | null;
  if (Array.isArray(o?.models)) {
    for (const m of o.models as { key?: unknown; max_context_length?: unknown; loaded_instances?: unknown }[]) {
      const instances = Array.isArray(m.loaded_instances)
        ? (m.loaded_instances as { id?: unknown; config?: { context_length?: unknown } }[])
        : [];
      if (m.key !== model && !instances.some((i) => i.id === model)) continue;
      // The instance the request names, else the first (that's the one LM Studio answers with).
      const inst = instances.find((i) => i.id === model) ?? instances[0];
      return { loaded: num(inst?.config?.context_length), max: num(m.max_context_length) };
    }
    return null;
  }
  if (Array.isArray(o?.data)) {
    const m = (o.data as { id?: unknown; loaded_context_length?: unknown; max_context_length?: unknown }[]).find((d) => d.id === model);
    return m ? { loaded: num(m.loaded_context_length), max: num(m.max_context_length) } : null;
  }
  return null;
}

/** llama.cpp GET /props: the window each request gets (one slot's share). */
export function parseLlamaProps(json: unknown): number | null {
  const o = json as { default_generation_settings?: { n_ctx?: unknown }; n_ctx?: unknown } | null;
  return num(o?.default_generation_settings?.n_ctx) ?? num(o?.n_ctx);
}

/** vLLM / SGLang GET /v1/models: max_model_len of the model. */
export function parseVllmModels(json: unknown, model: string): number | null {
  return num(vllmModel(json, model)?.max_model_len);
}

function vllmModel(json: unknown, model: string): { id?: unknown; owned_by?: unknown; max_model_len?: unknown } | undefined {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return undefined;
  return (data as { id?: unknown; owned_by?: unknown; max_model_len?: unknown }[]).find((d) => d.id === model);
}

/** llama.cpp-style GET /slots (Strata too): one slot's n_ctx. */
export function parseLlamaSlots(json: unknown): number | null {
  return Array.isArray(json) ? num((json[0] as { n_ctx?: unknown } | undefined)?.n_ctx) : null;
}

/** KoboldCpp GET /api/extra/true_max_context_length: {"value": N}. */
export function parseKoboldContext(json: unknown): number | null {
  return num((json as { value?: unknown } | null)?.value);
}

/** TabbyAPI GET /v1/model: the loaded model's card, its window in parameters.max_seq_len. */
export function parseTabbyModel(json: unknown): number | null {
  return num((json as { parameters?: { max_seq_len?: unknown } } | null)?.parameters?.max_seq_len);
}

/** Strata GET /v1/status: its state, with `loaded` and `auto_load` (no other engine has the pair). */
export function isStrataStatus(json: unknown): boolean {
  return !!json && typeof json === "object" && "auto_load" in json && "loaded" in json;
}

/** The server's root: the base URL without its /v1. */
function serverRoot(baseUrl: string): string {
  return normalizeBaseUrl(baseUrl).replace(/\/v1$/, "");
}

async function getJson(url: string, key: string, init?: RequestInit): Promise<unknown> {
  try {
    const res = await platform.fetch(url, { ...init, headers: localHeaders(key), connectTimeout: 1500 });
    return res.ok ? await res.json().catch(() => null) : null;
  } catch {
    return null;
  }
}

/**
 * Ask the server what window it has for a model, without loading anything.
 * null when it's none of the servers that say (BrewLM then goes by the
 * Settings choice).
 */
export async function readServerContext(server: { baseUrl: string; key: string }, model: string): Promise<ServerContext | null> {
  const root = serverRoot(server.baseUrl);
  if (!root || !model.trim()) return null;
  const get = (path: string) => getJson(`${root}${path}`, server.key);
  // All at once: a few quick calls to this computer, most of them 404s.
  const [kobold, strata, ps, lms, tabby, props, slots, models] = await Promise.all([
    get("/api/extra/true_max_context_length"),
    get("/v1/status"),
    get("/api/ps"),
    get("/api/v1/models").then((j) => j ?? get("/api/v0/models")),
    get("/v1/model"),
    get("/props"),
    get("/slots"),
    get("/v1/models"),
  ]);
  // The engines that imitate others' endpoints first, by their own.
  const k = parseKoboldContext(kobold);
  if (k) return { server: "KoboldCpp", loaded: k, max: null };
  // Strata lists an unloaded model too; its window is known only once loaded.
  if (isStrataStatus(strata)) return { server: "Strata", loaded: parseLlamaProps(props) ?? parseLlamaSlots(slots), max: null };
  const ollama = parseOllamaPs(ps, model);
  if (ollama !== undefined) {
    const show = await getJson(`${root}/api/show`, server.key, { method: "POST", body: JSON.stringify({ model }) });
    return { server: "Ollama", loaded: ollama, max: parseOllamaShow(show) };
  }
  const lm = parseLmStudioModels(lms, model);
  if (lm) return { server: "LM Studio", ...lm };
  const t = parseTabbyModel(tabby);
  if (t) return { server: "TabbyAPI", loaded: t, max: null };
  const llama = parseLlamaProps(props) ?? parseLlamaSlots(slots);
  if (llama) return { server: "llama.cpp", loaded: llama, max: null };
  const v = parseVllmModels(models, model);
  if (v) return { server: vllmModel(models, model)?.owned_by === "sglang" ? "SGLang" : "vLLM", loaded: v, max: v };
  return null;
}

interface CachedContext {
  ctx: ServerContext | null;
  at: number;
}
const contextCache = new Map<string, CachedContext>();
const inFlight = new Map<string, Promise<void>>();
/** A loaded size is re-checked after this long (the user may restart the server with another size). */
const CONTEXT_TTL = 60_000;
const cacheKey = (baseUrl: string, model: string) => `${normalizeBaseUrl(baseUrl)}|${model.trim()}`;

/** What the server last said about this model's window (null when unknown). */
export function knownServerContext(baseUrl: string, model: string): ServerContext | null {
  return contextCache.get(cacheKey(baseUrl, model))?.ctx ?? null;
}

/**
 * The window BrewLM sizes local requests for: what the server loaded on
 * Automatic, and never more than that on a picked size.
 */
export function effectiveContext(s: Pick<Settings, "localContext" | "localBaseUrl" | "model">): number {
  const loaded = s.localBaseUrl && s.model ? (knownServerContext(s.localBaseUrl, s.model)?.loaded ?? null) : null;
  const picked = s.localContext >= MIN_CONTEXT ? s.localContext : AUTO_CONTEXT;
  if (loaded) return picked ? Math.min(picked, loaded) : loaded;
  return picked || FALLBACK_CONTEXT;
}

/**
 * Make sure BrewLM knows the server's real window for the chat model before a
 * request is sized. Cheap when it's known (one quick local call a minute at
 * most). If the model isn't loaded yet and `load` is set, a one-token request
 * loads it first — the request about to be sent would load it anyway, and
 * only a loaded model's window is certain. Never throws.
 */
export async function ensureServerContext(
  s: Pick<Settings, "provider" | "localBaseUrl" | "localKey" | "model">,
  opts: { load?: boolean } = {}
): Promise<void> {
  if (platform.kind === "web" || s.provider !== "local" || !s.localBaseUrl?.trim() || !s.model?.trim()) return;
  const key = cacheKey(s.localBaseUrl, s.model);
  const cached = contextCache.get(key);
  if (cached && Date.now() - cached.at < CONTEXT_TTL) return;
  const running = inFlight.get(key);
  if (running) return running;
  const job = (async () => {
    const server = { baseUrl: s.localBaseUrl, key: s.localKey };
    let ctx = await readServerContext(server, s.model);
    if (ctx && ctx.loaded === null) {
      // Unloaded after idling: a size seen before still holds (servers load a model the same way each time).
      const before = cached?.ctx?.loaded ?? null;
      if (before) ctx = { ...ctx, loaded: before };
      else if (opts.load) {
        await warmUp(server, s.model);
        ctx = (await readServerContext(server, s.model)) ?? ctx;
      }
    }
    // Not loaded and not loading it now: ask again next time rather than caching a blank.
    if (ctx?.loaded === null && !cached) return;
    contextCache.set(key, { ctx, at: Date.now() });
  })()
    .catch(() => {})
    .finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}

/** Load a model the way a chat request does: one token, no streaming. */
async function warmUp(server: { baseUrl: string; key: string }, model: string): Promise<void> {
  try {
    await platform.fetch(`${normalizeBaseUrl(server.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: localHeaders(server.key),
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false }),
    });
  } catch {
    /* the real request reports an unreachable server */
  }
}

/** Forget what servers said (Settings → Test, or a new address). */
export function clearServerContext(): void {
  contextCache.clear();
}
