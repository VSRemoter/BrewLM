/**
 * Local / self-hosted models: any OpenAI-compatible server the user runs
 * (Ollama, LM Studio, llama.cpp, Jan, vLLM…). Requests go through the Tauri
 * HTTP plugin — i.e. the app's Rust backend — so servers need no CORS setup
 * and nothing is routed through a third party.
 *
 * Also owns the context budget: local models hold far less text than cloud
 * ones, so prompts are sized from the user's chosen context window.
 */
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
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

/** Model ids the server reports at GET {base}/models. Throws with a readable reason. */
export async function listLocalModels(server?: Pick<LocalServer, "baseUrl" | "key">): Promise<string[]> {
  const s = server ?? (await loadLocalServer());
  const base = normalizeBaseUrl(s.baseUrl);
  if (!base) return [];
  let res: Response;
  try {
    res = await tauriFetch(`${base}/models`, {
      headers: localHeaders(s.key),
      connectTimeout: 4000,
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
  sources: 30_000,
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
