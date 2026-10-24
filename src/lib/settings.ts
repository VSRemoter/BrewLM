import { platform } from "../platform";
import { getSetting, setSetting } from "./db";
import { DEFAULT_FONT, FONTS } from "./fonts";
import { isImageApiModel, listImageModels } from "./imageApi";
import { isEmbeddingModel, listLocalModels } from "./local";
import { DEFAULT_THEME, THEMES } from "./themes";
import type {
  Amount,
  AudioFormat,
  AudioLength,
  AudioMode,
  Difficulty,
  Provider,
  ReportType,
  Settings,
  TtsProvider,
} from "./types";

const DEFAULT_MODELS: Record<Provider, string> = {
  openrouter: "openai/gpt-4o-mini",
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
  // Local servers name models whatever the user pulled; picked after connecting.
  local: "",
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
  local: [],
};

/** Suggestions for Settings → Research model, per provider (any chat model id works). */
export const RESEARCH_MODEL_PRESETS: Record<Provider, string[]> = {
  openrouter: ["anthropic/claude-sonnet-4.5", "google/gemini-2.5-pro", "openai/gpt-4o"],
  openai: ["gpt-4.1", "o4-mini"],
  anthropic: ["claude-sonnet-4-5-20250929", "claude-opus-4-1-20250805"],
  local: [],
};

/** Default /image model: cheap (~$0.03/image) and supports aspect ratios. */
export const DEFAULT_IMAGE_MODEL = "google/gemini-3.1-flash-lite-image";

/** Suggestions for Settings → Image model (any OpenRouter Image API id works). */
export const IMAGE_MODEL_PRESETS = [
  "google/gemini-3.1-flash-lite-image",
  "google/gemini-3.1-flash-image",
  "google/gemini-3-pro-image",
  "openai/gpt-image-2",
  "openai/gpt-image-1-mini",
  "black-forest-labs/flux.2-klein-4b",
  "bytedance-seed/seedream-4.5",
];

export const PROVIDER_LABELS: Record<Provider, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic",
  local: "Local",
};

/** One-click server addresses for the popular local runners (all OpenAI-compatible). */
export const LOCAL_PRESETS: { id: string; label: string; url: string }[] = [
  { id: "ollama", label: "Ollama", url: "http://localhost:11434/v1" },
  { id: "lmstudio", label: "LM Studio", url: "http://localhost:1234/v1" },
  { id: "llamacpp", label: "llama.cpp", url: "http://localhost:8080/v1" },
];

/** Context-window choices for local models, in tokens. */
export const LOCAL_CONTEXT_OPTIONS = [4096, 8192, 16384, 32768, 131072];
const DEFAULT_LOCAL_CONTEXT = 8192;

export const TTS_PROVIDER_LABELS: Record<TtsProvider, string> = {
  system: "System voices",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  elevenlabs: "ElevenLabs",
};

export const DEFAULT_TTS_MODELS: Record<Exclude<TtsProvider, "system">, string> = {
  openai: "gpt-4o-mini-tts",
  openrouter: "openai/gpt-audio-mini",
  elevenlabs: "eleven_multilingual_v2",
};

export const TTS_MODEL_PRESETS: Record<Exclude<TtsProvider, "system">, string[]> = {
  openai: ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"],
  // Any OpenRouter speech model works; gpt-audio models go through chat completions.
  openrouter: ["openai/gpt-audio-mini", "openai/gpt-audio", "mistralai/voxtral-mini-tts-3-0"],
  elevenlabs: ["eleven_multilingual_v2", "eleven_flash_v2_5", "eleven_turbo_v2_5"],
};

export const OPENAI_TTS_VOICES = [
  "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse",
  "marin", "cedar",
];

/**
 * Starter voices for OpenRouter: gpt-audio's. Other OpenRouter speech models
 * name their own voices (e.g. voice_3150 for Voxtral TTS 3), so any name is accepted.
 */
export const OPENROUTER_TTS_VOICES = OPENAI_TTS_VOICES;

/** A few ElevenLabs premade voices so users don't have to hunt IDs down. */
export const ELEVENLABS_VOICE_PRESETS: { name: string; id: string }[] = [
  { name: "Rachel", id: "21m00Tcm4TlvDq8ikWAM" },
  { name: "Adam", id: "pNInz6obpgDQGcFmaJgB" },
  { name: "Bella", id: "EXAVITQu4vr4xnSDxMaL" },
  { name: "Antoni", id: "ErXwobaYiN019PkySvjV" },
  { name: "Elli", id: "MF3mGyEYCl7XYWbV9V6O" },
  { name: "Josh", id: "TxGEqnHWrfWFTfGW9XjX" },
];

const DEFAULT_TTS = {
  ttsProvider: "system" as TtsProvider,
  openaiTtsKey: "",
  openrouterTtsKey: "",
  elevenlabsKey: "",
  ttsModel: "",
  ttsVoiceAlex: "",
  ttsVoiceSam: "",
  ttsInstructions: "",
};

const DEFAULT_BEHAVIOR = {
  temperature: null as number | null,
  defFlashcardsAmount: "default" as Amount,
  defFlashcardsDifficulty: "medium" as Difficulty,
  defQuizAmount: "default" as Amount,
  defQuizDifficulty: "medium" as Difficulty,
  defAudioMode: "conversation" as AudioMode,
  defAudioFormat: "deep-dive" as AudioFormat,
  defAudioLength: "standard" as AudioLength,
  defReportType: "study-guide" as ReportType,
  trashRetentionDays: 0,
  updateCheckOnLaunch: true,
};

/** Vocab lists used to validate persisted Studio defaults. */
const AMOUNTS: Amount[] = ["compact", "default", "more"];
const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];
const AUDIO_MODES: AudioMode[] = ["conversation", "solo"];
const AUDIO_FORMATS: AudioFormat[] = ["deep-dive", "brief", "debate", "critique"];
const AUDIO_LENGTHS: AudioLength[] = ["short", "standard", "long"];
const REPORT_TYPES: ReportType[] = ["study-guide", "briefing-doc", "analysis", "custom"];

function pick<T extends string>(raw: string, vocab: T[], fallback: T): T {
  return (vocab as string[]).includes(raw) ? (raw as T) : fallback;
}

/**
 * Settings ↔ settings-table serialization. Temperature: "" ↔ null (provider
 * default — the param is omitted from requests). Booleans: "1"/"0".
 */
const SERIALIZERS: { [K in keyof Settings]: (s: Settings) => string } = {
  provider: (s) => s.provider,
  openrouterKey: (s) => s.openrouterKey,
  openaiKey: (s) => s.openaiKey,
  anthropicKey: (s) => s.anthropicKey,
  localBaseUrl: (s) => s.localBaseUrl,
  localKey: (s) => s.localKey,
  localEmbedModel: (s) => s.localEmbedModel,
  localContext: (s) => String(s.localContext),
  model: (s) => s.model,
  theme: (s) => s.theme,
  font: (s) => s.font,
  ttsProvider: (s) => s.ttsProvider,
  openaiTtsKey: (s) => s.openaiTtsKey,
  openrouterTtsKey: (s) => s.openrouterTtsKey,
  elevenlabsKey: (s) => s.elevenlabsKey,
  ttsModel: (s) => s.ttsModel,
  ttsVoiceAlex: (s) => s.ttsVoiceAlex,
  ttsVoiceSam: (s) => s.ttsVoiceSam,
  ttsInstructions: (s) => s.ttsInstructions,
  temperature: (s) => (s.temperature == null ? "" : String(s.temperature)),
  imageModel: (s) => s.imageModel,
  researchModels: (s) => JSON.stringify(s.researchModels ?? {}),
  defFlashcardsAmount: (s) => s.defFlashcardsAmount,
  defFlashcardsDifficulty: (s) => s.defFlashcardsDifficulty,
  defQuizAmount: (s) => s.defQuizAmount,
  defQuizDifficulty: (s) => s.defQuizDifficulty,
  defAudioMode: (s) => s.defAudioMode,
  defAudioFormat: (s) => s.defAudioFormat,
  defAudioLength: (s) => s.defAudioLength,
  defReportType: (s) => s.defReportType,
  trashRetentionDays: (s) => String(s.trashRetentionDays),
  updateCheckOnLaunch: (s) => (s.updateCheckOnLaunch ? "1" : "0"),
  smoothScroll: (s) => (s.smoothScroll ? "1" : "0"),
  showDetails: (s) => (s.showDetails ? "1" : "0"),
};

export async function loadSettings(): Promise<Settings> {
  const rawProvider = await getSetting("provider");
  const provider = (Object.prototype.hasOwnProperty.call(PROVIDER_LABELS, rawProvider) ? rawProvider : "openrouter") as Provider;
  const [
    openrouterKey, openaiKey, anthropicKey, model, theme, font,
    ttsProvider, openaiTtsKey, openrouterTtsKey, elevenlabsKey, ttsModel, ttsVoiceAlex, ttsVoiceSam, ttsInstructions,
    temperature, defFlashcardsAmount, defFlashcardsDifficulty,
    defQuizAmount, defQuizDifficulty, defAudioMode, defAudioFormat, defAudioLength,
    defReportType, trashRetentionDays, updateCheckOnLaunch, imageModel, smoothScroll, showDetails,
    localBaseUrl, localKey, localEmbedModel, localContext, researchModels,
  ] = await Promise.all([
    getSetting("openrouterKey"),
    getSetting("openaiKey"),
    getSetting("anthropicKey"),
    getSetting("model"),
    getSetting("theme"),
    getSetting("font"),
    getSetting("ttsProvider"),
    getSetting("openaiTtsKey"),
    getSetting("openrouterTtsKey"),
    getSetting("elevenlabsKey"),
    getSetting("ttsModel"),
    getSetting("ttsVoiceAlex"),
    getSetting("ttsVoiceSam"),
    getSetting("ttsInstructions"),
    getSetting("temperature"),
    getSetting("defFlashcardsAmount"),
    getSetting("defFlashcardsDifficulty"),
    getSetting("defQuizAmount"),
    getSetting("defQuizDifficulty"),
    getSetting("defAudioMode"),
    getSetting("defAudioFormat"),
    getSetting("defAudioLength"),
    getSetting("defReportType"),
    getSetting("trashRetentionDays"),
    getSetting("updateCheckOnLaunch"),
    getSetting("imageModel"),
    getSetting("smoothScroll"),
    getSetting("showDetails"),
    getSetting("localBaseUrl"),
    getSetting("localKey"),
    getSetting("localEmbedModel"),
    getSetting("localContext"),
    getSetting("researchModels"),
  ]);
  // Validate what we read — earlier builds may have persisted garbage values.
  const ttsProv: TtsProvider = (Object.keys(TTS_PROVIDER_LABELS) as TtsProvider[]).includes(
    ttsProvider as TtsProvider
  )
    ? (ttsProvider as TtsProvider)
    : // Default: if an OpenAI key exists, keep the old auto-mp3 behavior via OpenAI TTS.
      openaiKey
      ? "openai"
      : DEFAULT_TTS.ttsProvider;
  // Repair paths if a broken build persisted shifted values (model ← key, theme ← model).
  const safeModel = model && !model.startsWith("sk-") ? model : DEFAULT_MODELS[provider];
  const themeIds = new Set(THEMES.map((t) => t.id));
  const safeTheme = theme && themeIds.has(theme) ? theme : DEFAULT_THEME;
  const fontIds = new Set(FONTS.map((f) => f.id));
  const safeFont = font && fontIds.has(font) ? font : DEFAULT_FONT;
  // Gemini TTS ids are gone from OpenRouter (they 400 "not a valid model ID") —
  // drop them so the openrouter default kicks in.
  const safeTtsModel = ttsModel && !/^google\/.*(tts|gemini)/i.test(ttsModel.trim())
    ? ttsModel
    : DEFAULT_TTS.ttsModel;
  // Old Gemini voice names are invalid for gpt-audio — drop them too.
  const geminiVoices = new Set([
    "Kore", "Charon", "Puck", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr",
    "Callirrhoe", "Achernar", "Alnilam", "Schedar",
  ]);
  const scrubVoice = (v: string) => (geminiVoices.has(v.trim()) ? DEFAULT_TTS.ttsVoiceAlex : v);
  // Temperature: "" → null (provider default); otherwise clamp to the 0–1 range
  // all three providers accept.
  const parsedTemp = Number.parseFloat(temperature);
  const safeTemp = Number.isFinite(parsedTemp)
    ? Math.min(1, Math.max(0, parsedTemp))
    : DEFAULT_BEHAVIOR.temperature;
  const parsedContext = Number.parseInt(localContext, 10);
  const safeContext = Number.isFinite(parsedContext) && parsedContext >= 2048 ? parsedContext : DEFAULT_LOCAL_CONTEXT;
  const parsedRetention = Number.parseInt(trashRetentionDays, 10);
  const safeRetention = [0, 7, 30, 90].includes(parsedRetention)
    ? parsedRetention
    : DEFAULT_BEHAVIOR.trashRetentionDays;
  return cloudProviderOnWeb({
    provider,
    openrouterKey,
    openaiKey,
    anthropicKey,
    localBaseUrl,
    localKey,
    localEmbedModel,
    localContext: safeContext,
    model: safeModel,
    theme: safeTheme,
    font: safeFont,
    ttsProvider: ttsProv,
    openaiTtsKey: openaiTtsKey || DEFAULT_TTS.openaiTtsKey,
    openrouterTtsKey: openrouterTtsKey || DEFAULT_TTS.openrouterTtsKey,
    elevenlabsKey: elevenlabsKey || DEFAULT_TTS.elevenlabsKey,
    ttsModel: safeTtsModel,
    ttsVoiceAlex: scrubVoice(ttsVoiceAlex) || DEFAULT_TTS.ttsVoiceAlex,
    ttsVoiceSam: scrubVoice(ttsVoiceSam) || DEFAULT_TTS.ttsVoiceSam,
    ttsInstructions: ttsInstructions || DEFAULT_TTS.ttsInstructions,
    temperature: safeTemp,
    imageModel: imageModel.trim() || DEFAULT_IMAGE_MODEL,
    researchModels: parseResearchModels(researchModels),
    defFlashcardsAmount: pick(defFlashcardsAmount, AMOUNTS, DEFAULT_BEHAVIOR.defFlashcardsAmount),
    defFlashcardsDifficulty: pick(defFlashcardsDifficulty, DIFFICULTIES, DEFAULT_BEHAVIOR.defFlashcardsDifficulty),
    defQuizAmount: pick(defQuizAmount, AMOUNTS, DEFAULT_BEHAVIOR.defQuizAmount),
    defQuizDifficulty: pick(defQuizDifficulty, DIFFICULTIES, DEFAULT_BEHAVIOR.defQuizDifficulty),
    defAudioMode: pick(defAudioMode, AUDIO_MODES, DEFAULT_BEHAVIOR.defAudioMode),
    defAudioFormat: pick(defAudioFormat, AUDIO_FORMATS, DEFAULT_BEHAVIOR.defAudioFormat),
    defAudioLength: pick(defAudioLength, AUDIO_LENGTHS, DEFAULT_BEHAVIOR.defAudioLength),
    defReportType: pick(defReportType, REPORT_TYPES, DEFAULT_BEHAVIOR.defReportType),
    trashRetentionDays: safeRetention,
    // Missing key (fresh install / older build) → on.
    updateCheckOnLaunch: updateCheckOnLaunch !== "0",
    smoothScroll: smoothScroll !== "0",
    showDetails: showDetails !== "0",
  });
}

/**
 * Local models (Ollama, LM Studio…) run on the computer, out of the web app's
 * reach. When the synced choice is "local", the web app uses the first cloud
 * provider it has a key for, with that provider's default model, without
 * changing the stored choice: the computer keeps its local model.
 */
function cloudProviderOnWeb(s: Settings): Settings {
  if (platform.kind !== "web" || s.provider !== "local") return s;
  const provider = (["openrouter", "openai", "anthropic"] as const).find((p) => activeKey({ ...s, provider: p })) ?? "openrouter";
  return { ...s, provider, model: defaultModelFor(provider) };
}

/** Stored JSON {provider: id} → only string entries for known providers. */
function parseResearchModels(raw: string): Partial<Record<Provider, string>> {
  const out: Partial<Record<Provider, string>> = {};
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    for (const p of Object.keys(PROVIDER_LABELS) as Provider[]) {
      if (typeof parsed?.[p] === "string" && parsed[p].trim()) out[p] = parsed[p].trim();
    }
  } catch {
    /* corrupt value → every provider falls back to its main model */
  }
  return out;
}

/** The model /research and /search run on: the provider's research pick, else the main model. */
export function researchModelFor(s: Settings): string {
  return s.researchModels?.[s.provider]?.trim() || s.model;
}

export async function saveSettings(s: Settings): Promise<void> {
  await patchSettings(s);
}

/**
 * Instant-apply persistence for the settings page: write only the keys present
 * in the patch instead of dumping the whole object.
 */
export async function patchSettings(patch: Partial<Settings>): Promise<void> {
  // A model picked on the web while the stored provider is "local" (see
  // cloudProviderOnWeb) travels with the provider it belongs to; otherwise the
  // computer would get a cloud model id for its local server.
  if (platform.kind === "web" && patch.model !== undefined && patch.provider === undefined && (await getSetting("provider")) === "local")
    patch = { ...patch, provider: (await loadSettings()).provider };
  const writes: Promise<void>[] = [];
  for (const key of Object.keys(patch) as (keyof Settings)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    writes.push(setSetting(key, SERIALIZERS[key]({ ...patch } as Settings)));
  }
  await Promise.all(writes);
}

export function activeKey(s: Settings): string {
  switch (s.provider) {
    case "openrouter":
      return s.openrouterKey;
    case "openai":
      return s.openaiKey;
    case "anthropic":
      return s.anthropicKey;
    case "local":
      // Local servers usually need no key: any non-empty value tells callers
      // "configured"; the local request path sends a real key only if set.
      return s.localBaseUrl ? s.localKey || "local" : "";
  }
}

export function defaultModelFor(p: Provider): string {
  return DEFAULT_MODELS[p];
}

/* -------------------- User-editable per-provider model lists -------------------- */

const CUSTOM_MODELS_KEY = (p: Provider) => `customModels.${p}`;

/** The provider's chip list: defaults unless the user has customized (added/removed).
 *  Local: whatever the server reports right now, plus any ids the user saved. */
export async function loadModelList(p: Provider): Promise<string[]> {
  if (p === "local") {
    const [saved, served] = await Promise.all([loadSavedModels(p), listLocalModels().catch(() => [])]);
    return [...new Set([...served.filter((m) => !isEmbeddingModel(m)), ...saved])];
  }
  return loadSavedModels(p);
}

function loadSavedModels(p: Provider): Promise<string[]> {
  return loadList(CUSTOM_MODELS_KEY(p), MODEL_PRESETS[p]);
}

export function saveModelList(p: Provider, list: string[]): Promise<void> {
  return saveList(CUSTOM_MODELS_KEY(p), MODEL_PRESETS[p], list);
}

/** The provider's Research model list (Settings → Research model, /researchmodel add|remove). */
export function loadResearchModelList(p: Provider): Promise<string[]> {
  return loadList(`customModels.research.${p}`, RESEARCH_MODEL_PRESETS[p]);
}

export function saveResearchModelList(p: Provider, list: string[]): Promise<void> {
  return saveList(`customModels.research.${p}`, RESEARCH_MODEL_PRESETS[p], list);
}

/** The TTS provider's model list (Settings → Audio Voices). */
export function loadTtsModelList(p: VoiceProvider): Promise<string[]> {
  return loadList(`ttsModels.${p}`, TTS_MODEL_PRESETS[p]);
}

export function saveTtsModelList(p: VoiceProvider, list: string[]): Promise<void> {
  return saveList(`ttsModels.${p}`, TTS_MODEL_PRESETS[p], list);
}

/* --------------------------- Saved voices (/voice) --------------------------- */

/** TTS providers whose voices the user picks (System voices are chosen by the OS). */
export type VoiceProvider = Exclude<TtsProvider, "system">;

/** A saved voice: a friendly name and what the provider expects (an ElevenLabs voice ID, or the OpenAI voice name). */
export interface SavedVoice {
  name: string;
  id: string;
}

const VOICE_PRESETS: Record<VoiceProvider, SavedVoice[]> = {
  openai: OPENAI_TTS_VOICES.map((v) => ({ name: v, id: v })),
  openrouter: OPENROUTER_TTS_VOICES.map((v) => ({ name: v, id: v })),
  elevenlabs: ELEVENLABS_VOICE_PRESETS,
};

/** The only voices a provider accepts, or null when any voice works (OpenRouter, ElevenLabs). */
export function builtInVoices(p: VoiceProvider): string[] | null {
  return p === "openai" ? OPENAI_TTS_VOICES : null;
}

/** ElevenLabs voices are opaque IDs, so they get a separate friendly name; others are named by their voice value. */
export function voicesNeedIds(p: VoiceProvider): boolean {
  return p === "elevenlabs";
}

export async function loadVoiceList(p: VoiceProvider): Promise<SavedVoice[]> {
  const raw = await getSetting(`voices.${p}`);
  if (!raw) return [...VOICE_PRESETS[p]];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed))
      return parsed.filter(
        (v): v is SavedVoice => typeof v?.name === "string" && typeof v?.id === "string"
      );
  } catch {
    /* fall through to defaults */
  }
  return [...VOICE_PRESETS[p]];
}

export async function saveVoiceList(p: VoiceProvider, list: SavedVoice[]): Promise<void> {
  const presets = VOICE_PRESETS[p];
  const isDefault =
    list.length === presets.length &&
    list.every((v, i) => v.name === presets[i].name && v.id === presets[i].id);
  await setSetting(`voices.${p}`, isDefault ? "" : JSON.stringify(list));
}

/** OpenAI / OpenRouter voices used when a host's voice is left empty. */
export const DEFAULT_HOST_VOICES = { Alex: "nova", Sam: "onyx" } as const;

export type Host = keyof typeof DEFAULT_HOST_VOICES;

/**
 * The voice a host actually speaks with on the selected TTS provider ("" = none set).
 * Voices are stored once for all providers, so a value left over from the other
 * kind (an OpenAI name on ElevenLabs, or an ElevenLabs ID on OpenAI) is ignored.
 */
export function hostVoice(s: Settings, host: Host): string {
  const v = (host === "Alex" ? s.ttsVoiceAlex : s.ttsVoiceSam).trim();
  if (s.ttsProvider === "system") return v;
  if (s.ttsProvider === "elevenlabs") return OPENAI_TTS_VOICES.includes(v.toLowerCase()) ? "" : v;
  // ElevenLabs IDs are 20 mixed-case letters/digits; OpenAI voices are lowercase words.
  const looksLikeElevenLabsId = /^[A-Za-z0-9]{20}$/.test(v) && /[A-Z0-9]/.test(v);
  return v && !looksLikeElevenLabsId ? v : DEFAULT_HOST_VOICES[host];
}

/** Find a saved voice by name or ID, ignoring case. */
export function findVoice(list: SavedVoice[], query: string): SavedVoice | undefined {
  const q = query.trim().toLowerCase();
  return list.find((v) => v.name.toLowerCase() === q) ?? list.find((v) => v.id.toLowerCase() === q);
}

/** Display name for a stored voice value: its saved name, else the raw value. */
export function voiceLabel(list: SavedVoice[], id: string): string {
  return list.find((v) => v.id === id)?.name ?? id;
}

const IMAGE_MODELS_KEY = "customModels.image";

/** The /image model list (Settings → Image model, /imagemodel add|remove). */
export function loadImageModelList(): Promise<string[]> {
  return loadList(IMAGE_MODELS_KEY, IMAGE_MODEL_PRESETS);
}

export function saveImageModelList(list: string[]): Promise<void> {
  return saveList(IMAGE_MODELS_KEY, IMAGE_MODEL_PRESETS, list);
}

async function loadList(key: string, presets: string[]): Promise<string[]> {
  const raw = await getSetting(key);
  if (!raw) return [...presets];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((m): m is string => typeof m === "string");
  } catch {
    /* fall through to defaults */
  }
  return [...presets];
}

async function saveList(key: string, presets: string[], list: string[]): Promise<void> {
  // Storing exact parity with defaults would also be fine, but keying off "is it customized"
  // keeps fresh installs picking up new presets we ship later.
  const isDefault = list.length === presets.length && list.every((m, i) => m === presets[i]);
  await setSetting(key, isDefault ? "" : JSON.stringify(list));
}

/* ---------------------- /model add: OpenRouter id checks ---------------------- */

/**
 * Turn what a user pasted into a bare model id: strips quotes and an
 * openrouter.ai model-page URL (https://openrouter.ai/anthropic/claude-haiku-5.5).
 */
export function normalizeModelId(raw: string): string {
  let id = raw.trim().replace(/^["'`]+|["'`]+$/g, "").trim();
  const url = /^(?:https?:\/\/)?(?:www\.)?openrouter\.ai\/(?:models\/)?([^?#\s]+)/i.exec(id);
  if (url) id = url[1].split("/").slice(0, 2).join("/");
  return id;
}

let openRouterIds: Promise<string[] | null> | null = null;

/** Every chat model id OpenRouter lists (public endpoint, cached per session). */
function loadOpenRouterIds(): Promise<string[] | null> {
  return (openRouterIds ??= fetch("https://openrouter.ai/api/v1/models")
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (Array.isArray(j?.data) ? j.data.map((m: { id: string }) => m.id) : null))
    .catch(() => null)
    .then((ids) => {
      if (!ids) openRouterIds = null; // retry next time
      return ids;
    }));
}

export type ModelCheck =
  | { status: "ok" }
  | { status: "unknown"; suggestions: string[] }
  /** Couldn't reach OpenRouter — the id can't be verified either way. */
  | { status: "unverified" };

/** Is `id` a real OpenRouter model (chat or image)? Suggests close ids when not. */
export async function checkOpenRouterModel(id: string): Promise<ModelCheck> {
  const ids = await loadOpenRouterIds();
  if (ids?.includes(id) || (await isImageApiModel(id))) return { status: "ok" };
  if (!ids) return { status: "unverified" };
  return { status: "unknown", suggestions: closeIds(id, ids) };
}

/** Is `id` an OpenRouter Image API model (what /image can run)? */
export async function checkImageModel(id: string): Promise<ModelCheck> {
  const ids = await listImageModels();
  if (ids.includes(id)) return { status: "ok" };
  if (ids.length === 0) return { status: "unverified" };
  return { status: "unknown", suggestions: closeIds(id, ids) };
}

/** Up to three ids sharing the most name parts with `id`. */
function closeIds(id: string, ids: string[]): string[] {
  const tokens = id.toLowerCase().split(/[/:._-]+/).filter((t) => t.length >= 3);
  return ids
    .map((m) => ({ m, score: tokens.filter((t) => m.toLowerCase().includes(t)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.m.length - b.m.length)
    .slice(0, 3)
    .map((x) => x.m);
}
