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
  const ctx = Number.parseInt(context, 10);
  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    key,
    context: Number.isFinite(ctx) && ctx >= 2048 ? ctx : 8192,
  };
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
const DETECT_TARGETS: { label: string; port: number }[] = [
  { label: "Ollama", port: 11434 },
  { label: "LM Studio", port: 1234 },
  { label: "llama.cpp", port: 8080 },
  { label: "Jan", port: 1337 },
  { label: "vLLM or Speaches", port: 8000 },
];

export interface FoundServer {
  label: string;
  baseUrl: string;
  models: string[];
}

/** Local servers answering on their usual ports, checked side by side. */
export async function detectLocalServers(): Promise<FoundServer[]> {
  const found = await Promise.all(
    DETECT_TARGETS.map(async ({ label, port }) => {
      const baseUrl = `http://localhost:${port}/v1`;
      try {
        return { label, baseUrl, models: await listLocalModels({ baseUrl, key: "" }, 1500) };
      } catch {
        return null;
      }
    })
  );
  return found.filter((f): f is FoundServer => f !== null);
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

export function contextBudget(s: Pick<Settings, "provider" | "localContext">): ContextBudget {
  return s.provider === "local" ? budgetForContext(s.localContext) : CLOUD_BUDGET;
}
