import { getSetting, setSetting } from "./db";
import { DEFAULT_FONT, FONTS } from "./fonts";
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
  // OpenRouter only routes OpenAI's audio models for audio output.
  openrouter: ["openai/gpt-audio-mini", "openai/gpt-audio"],
  elevenlabs: ["eleven_multilingual_v2", "eleven_flash_v2_5", "eleven_turbo_v2_5"],
};

export const OPENAI_TTS_VOICES = [
  "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse",
];

/** gpt-audio voices (the only audio-output models OpenRouter routes). */
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
};

export async function loadSettings(): Promise<Settings> {
  const provider = ((await getSetting("provider")) || "openrouter") as Provider;
  const [
    openrouterKey, openaiKey, anthropicKey, model, theme, font,
    ttsProvider, openaiTtsKey, openrouterTtsKey, elevenlabsKey, ttsModel, ttsVoiceAlex, ttsVoiceSam, ttsInstructions,
    temperature, defFlashcardsAmount, defFlashcardsDifficulty,
    defQuizAmount, defQuizDifficulty, defAudioMode, defAudioFormat, defAudioLength,
    defReportType, trashRetentionDays, updateCheckOnLaunch,
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
  const parsedRetention = Number.parseInt(trashRetentionDays, 10);
  const safeRetention = [0, 7, 30, 90].includes(parsedRetention)
    ? parsedRetention
    : DEFAULT_BEHAVIOR.trashRetentionDays;
  return {
    provider,
    openrouterKey,
    openaiKey,
    anthropicKey,
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
  };
}

export async function saveSettings(s: Settings): Promise<void> {
  await patchSettings(s);
}

/**
 * Instant-apply persistence for the settings page: write only the keys present
 * in the patch instead of dumping the whole object.
 */
export async function patchSettings(patch: Partial<Settings>): Promise<void> {
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
  }
}

export function defaultModelFor(p: Provider): string {
  return DEFAULT_MODELS[p];
}

/* -------------------- User-editable per-provider model lists -------------------- */

const CUSTOM_MODELS_KEY = (p: Provider) => `customModels.${p}`;

/** The provider's chip list: defaults unless the user has customized (added/removed). */
export async function loadModelList(p: Provider): Promise<string[]> {
  const raw = await getSetting(CUSTOM_MODELS_KEY(p));
  if (!raw) return [...MODEL_PRESETS[p]];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((m): m is string => typeof m === "string");
  } catch {
    /* fall through to defaults */
  }
  return [...MODEL_PRESETS[p]];
}

export async function saveModelList(p: Provider, list: string[]): Promise<void> {
  // Storing exact parity with defaults would also be fine, but keying off "is it customized"
  // keeps fresh installs picking up new presets we ship later.
  const isDefault =
    list.length === MODEL_PRESETS[p].length && list.every((m, i) => m === MODEL_PRESETS[p][i]);
  await setSetting(CUSTOM_MODELS_KEY(p), isDefault ? "" : JSON.stringify(list));
}
