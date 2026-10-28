/**
 * What a cloud model can do, looked up once per session: its context window,
 * how much it may write in one reply, and which reasoning-effort levels it
 * accepts. llm.ts sizes every request from this, so users never pick a token
 * number that the model then rejects.
 */
import type { Provider } from "./types";

export interface ModelLimits {
  /** Context window in tokens. */
  context?: number;
  /** Most tokens the model may write in one reply. */
  maxOutput?: number;
  /** Effort levels the model accepts ("low", "medium", "high"); empty = don't send one. */
  efforts: string[];
}

/** The fields of OpenRouter's public model list that BrewLM reads. */
export interface OpenRouterModel {
  id: string;
  context_length?: number | null;
  top_provider?: { context_length?: number | null; max_completion_tokens?: number | null } | null;
  supported_parameters?: string[];
}

export const STANDARD_EFFORTS = ["low", "medium", "high"];

let openRouterCatalog: Promise<OpenRouterModel[] | null> | null = null;

/** OpenRouter's public model list (no key needed), cached per session. */
export function loadOpenRouterCatalog(): Promise<OpenRouterModel[] | null> {
  return (openRouterCatalog ??= fetch("https://openrouter.ai/api/v1/models")
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (Array.isArray(j?.data) ? (j.data as OpenRouterModel[]) : null))
    .catch(() => null)
    .then((list) => {
      if (!list) openRouterCatalog = null; // retry next time
      return list;
    }));
}

const positive = (n: unknown): number | undefined => (typeof n === "number" && n > 0 ? n : undefined);

async function openRouterLimits(model: string): Promise<ModelLimits | null> {
  const m = (await loadOpenRouterCatalog())?.find((x) => x.id === model);
  if (!m) return null;
  return {
    context: positive(m.top_provider?.context_length) ?? positive(m.context_length),
    maxOutput: positive(m.top_provider?.max_completion_tokens),
    efforts: m.supported_parameters?.includes("reasoning") ? STANDARD_EFFORTS : [],
  };
}

/** Anthropic's Models API reports both limits and the effort levels each model takes. */
async function anthropicLimits(apiKey: string, model: string): Promise<ModelLimits | null> {
  const res = await fetch(`https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`, {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
  });
  if (!res.ok) return null;
  const m = await res.json();
  const effort = m?.capabilities?.effort;
  return {
    context: positive(m?.max_input_tokens),
    maxOutput: positive(m?.max_tokens),
    efforts: effort?.supported ? STANDARD_EFFORTS.filter((level) => effort[level]?.supported) : [],
  };
}

const cache = new Map<string, Promise<ModelLimits | null>>();

/**
 * The model's limits, or null when they can't be found (unknown id, no network,
 * or OpenAI, which doesn't publish them). Local models are sized from the
 * context window set in Settings instead.
 */
export function modelLimits(provider: Provider, apiKey: string, model: string): Promise<ModelLimits | null> {
  if (provider !== "openrouter" && provider !== "anthropic") return Promise.resolve(null);
  const key = `${provider}:${model}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = (provider === "openrouter" ? openRouterLimits(model) : anthropicLimits(apiKey, model)).catch(() => null);
    // A failed lookup is retried on the next request instead of being remembered.
    hit.then((v) => v ?? cache.delete(key));
    cache.set(key, hit);
  }
  return hit;
}
