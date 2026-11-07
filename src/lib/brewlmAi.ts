/**
 * BrewLM AI: AI included with the Pro and Max plans, no API key needed.
 *
 * Requests use OpenRouter's own format, but go to the sync server's proxy
 * (sync-server/src/ai.ts) with this device's BrewLM session instead of a key.
 * The server runs them on the account's capped OpenRouter key, which never
 * reaches the app, and allows only the models in its config: the three chat
 * tiers below plus fixed models for research, voices, transcription, pictures
 * and embeddings. GET /v1/ai/config says which; changing a model there needs
 * no app release.
 */
import { getSyncStatus, shareServer } from "./sync";
import type { Provider, TtsProvider } from "./types";

export const OPENROUTER_API = "https://openrouter.ai/api/v1";

export type AiTier = "fast" | "smart" | "best";

export interface AiConfig {
  version: number;
  tiers: Record<AiTier, { label: string; model: string }>;
  defaultTier: AiTier;
  roles: {
    background: string;
    research: { planner: string; reader: string };
    tts: { model: string; voices: { host: string; cohost: string } };
    transcribe: string;
    image: string;
    embedding: { model: string; dims: number; version: number };
  };
}

/** The server's config as of this release, used until (or when) the live one can't be fetched. */
const BUILT_IN: AiConfig = {
  version: 1,
  tiers: {
    fast: { label: "Fast", model: "anthropic/claude-haiku-5.5" },
    smart: { label: "Smart", model: "anthropic/claude-sonnet-5.5" },
    best: { label: "Best", model: "anthropic/claude-opus-5.5" },
  },
  defaultTier: "fast",
  roles: {
    background: "anthropic/claude-haiku-5.5",
    research: { planner: "anthropic/claude-sonnet-5.5", reader: "anthropic/claude-haiku-5.5" },
    tts: { model: "google/gemini-3.8-flash-tts", voices: { host: "Puck", cohost: "Kore" } },
    transcribe: "google/gemini-3.5-flash-lite",
    image: "google/gemini-3.1-flash-lite-image",
    embedding: { model: "openai/text-embedding-3-small", dims: 512, version: 1 },
  },
};

export const AI_TIERS: AiTier[] = ["fast", "smart", "best"];
export const TIER_DESCRIPTIONS: Record<AiTier, string> = {
  fast: "Quick and light on your allowance. Right for most questions.",
  smart: "Stronger reasoning and writing, for harder questions and long reports.",
  best: "The most capable model, for the hardest work. Uses your allowance fastest.",
};

const CONFIG_TTL_MS = 60 * 60 * 1000;
let config: AiConfig = BUILT_IN;
let fetchedAt = 0;
let inflight: Promise<AiConfig> | null = null;

function validConfig(v: unknown): v is AiConfig {
  const c = v as AiConfig;
  return (
    !!c?.tiers &&
    AI_TIERS.every((t) => typeof c.tiers[t]?.model === "string") &&
    typeof c.roles?.tts?.model === "string" &&
    typeof c.roles?.embedding?.model === "string" &&
    typeof c.roles?.image === "string" &&
    typeof c.roles?.transcribe === "string" &&
    typeof c.roles?.research?.planner === "string"
  );
}

/** The live config (refreshed hourly), or the built-in one when the server can't be reached. */
export function loadAiConfig(): Promise<AiConfig> {
  if (Date.now() - fetchedAt < CONFIG_TTL_MS) return Promise.resolve(config);
  const server = shareServer();
  if (!server) return Promise.resolve(config);
  return (inflight ??= fetch(`${server.url}/v1/ai/config`)
    .then((r) => (r.ok ? r.json() : null))
    .then((c) => {
      if (validConfig(c)) {
        config = c;
        fetchedAt = Date.now();
      }
      return config;
    })
    .catch(() => config)
    .finally(() => {
      inflight = null;
    }));
}

/** The config as last fetched, for code that can't wait. */
export function aiConfigNow(): AiConfig {
  void loadAiConfig();
  return config;
}

/** The tier a chat model id belongs to, if it's one of BrewLM AI's. */
export function tierOf(model: string): AiTier | null {
  return AI_TIERS.find((t) => config.tiers[t].model === model) ?? null;
}

/** "Fast", "Smart"… for a tier model; the id itself otherwise. */
export function brewlmModelLabel(model: string): string {
  const t = tierOf(model);
  return t ? config.tiers[t].label : model;
}

/* -------------------------------- requests -------------------------------- */

/** Providers whose requests use OpenRouter's API format (BrewLM AI goes through OpenRouter). */
export function speaksOpenRouter(p: Provider | TtsProvider): boolean {
  return p === "openrouter" || p === "brewlm";
}

/** This device's BrewLM session, when signed in to an account (the "key" BrewLM AI requests carry). */
export function brewlmSession(): string {
  return shareServer()?.session ?? "";
}

/** Whether the signed-in account's plan includes BrewLM AI (unknown until the account loads → true, and the server decides). */
export function planHasAi(): boolean {
  const plan = getSyncStatus().account?.plan;
  return plan === undefined || plan === "pro" || plan === "max";
}

export const SIGN_IN_FOR_AI = "BrewLM AI needs your BrewLM account. Sign in under Settings → Sync, or pick another provider in Settings → AI Model.";

/**
 * Where an OpenRouter-format request goes, and with what credential: the
 * proxy and the session for BrewLM AI, OpenRouter and the user's key otherwise.
 * `headers` are OpenRouter's attribution headers, which only go to OpenRouter
 * itself (the proxy adds its own, and they'd fail the web app's CORS check).
 */
export function openRouterApi(provider: Provider | TtsProvider, key: string): { base: string; key: string; headers: Record<string, string> } {
  if (provider === "brewlm") {
    const server = shareServer();
    if (!server) throw new Error(SIGN_IN_FOR_AI);
    return { base: `${server.url}/v1/ai/openrouter`, key: server.session, headers: {} };
  }
  return { base: OPENROUTER_API, key, headers: { "HTTP-Referer": "https://brewlm.app", "X-Title": "BrewLM" } };
}

/* ---------------------------------- usage --------------------------------- */

export interface AiUsage {
  plan: string | null;
  trial: boolean;
  /** 0–1 of this month's allowance (top-ups included). */
  usedFraction: number;
  resetsAt: number;
  /** Roughly how many of each are left; null without an AI plan. */
  left: { chats: number; audioOverviews: number; researchRuns: number; transcriptionHours: number; images: number } | null;
}

/** This month's BrewLM AI allowance; null when signed out or the server can't be reached. */
export async function fetchAiUsage(): Promise<AiUsage | null> {
  const server = shareServer();
  if (!server) return null;
  try {
    const r = await fetch(`${server.url}/v1/ai/usage`, { headers: { authorization: `Bearer ${server.session}` } });
    return r.ok ? ((await r.json()) as AiUsage) : null;
  } catch {
    return null;
  }
}
