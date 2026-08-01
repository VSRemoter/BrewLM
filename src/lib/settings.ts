import { getSetting, setSetting } from "./db";
import { DEFAULT_THEME } from "./themes";
import type { Provider, Settings } from "./types";

const DEFAULT_MODELS: Record<Provider, string> = {
  openrouter: "openai/gpt-4o-mini",
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
};

export const MODEL_PRESETS: Record<Provider, string[]> = {
  openrouter: [
    "openai/gpt-4o-mini",
    "openai/gpt-4o",
    "anthropic/claude-sonnet-4.5",
    "anthropic/claude-haiku-4.5",
    "google/gemini-2.5-flash",
    "meta-llama/llama-3.3-70b-instruct",
    "deepseek/deepseek-chat-v3.1",
  ],
  openai: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1", "o4-mini"],
  anthropic: [
    "claude-haiku-4-5-20251001",
    "claude-sonnet-4-5-20250929",
    "claude-opus-4-1-20250805",
  ],
};

export const PROVIDER_LABELS: Record<Provider, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic",
};

export async function loadSettings(): Promise<Settings> {
  const provider = ((await getSetting("provider")) || "openrouter") as Provider;
  const [openrouterKey, openaiKey, anthropicKey, model, theme] = await Promise.all([
    getSetting("openrouterKey"),
    getSetting("openaiKey"),
    getSetting("anthropicKey"),
    getSetting("model"),
    getSetting("theme"),
  ]);
  return {
    provider,
    openrouterKey,
    openaiKey,
    anthropicKey,
    model: model || DEFAULT_MODELS[provider],
    theme: theme || DEFAULT_THEME,
  };
}

export async function saveSettings(s: Settings): Promise<void> {
  await Promise.all([
    setSetting("provider", s.provider),
    setSetting("openrouterKey", s.openrouterKey),
    setSetting("openaiKey", s.openaiKey),
    setSetting("anthropicKey", s.anthropicKey),
    setSetting("model", s.model),
    setSetting("theme", s.theme),
  ]);
}

export function activeKey(s: Settings): string {
  switch (s.provider) {
    case "openrouter":
      return s.openrouterKey;
    case "openai":
      return s.openaiKey;
    case "anthropic":
      return s.anthropicKey;
  }
}

export function defaultModelFor(p: Provider): string {
  return DEFAULT_MODELS[p];
}
