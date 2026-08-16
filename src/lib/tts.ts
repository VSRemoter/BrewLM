/** Text-to-speech for studio audio: OpenAI, ElevenLabs, or in-app system voices. */

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { sseLines } from "./llm";
import { DEFAULT_TTS_MODELS } from "./settings";
import type { Settings } from "./types";

export interface ScriptTurn {
  speaker: "Alex" | "Sam";
  text: string;
}

export interface TtsResult {
  /** data:audio/mpeg;base64 url, or null when only the script is available. */
  audio: string | null;
  /** User-facing explanation when audio is null (or a warning). */
  note?: string;
}

const OPENAI_VOICE_DEFAULTS = { Alex: "nova", Sam: "onyx" };
const OPENROUTER_VOICE_DEFAULTS = { Alex: "nova", Sam: "onyx" };

/** OpenAI audio models output raw pcm16 at 24kHz mono. */
const PCM16_RATE = 24000;

/** base64 → raw bytes → 16-bit LE PCM → float samples. */
function pcm16Base64ToFloat32(b64: string): Float32Array {
  const bin = atob(b64);
  const n = (bin.length - (bin.length % 2)) / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    out[i] = (v >= 0x8000 ? v - 0x10000 : v) / 32768;
  }
  return out;
}

/**
 * gpt-audio is a chat model — a system role barely steers it, but a direct
 * imperative user message makes it read verbatim (verified live). The strict
 * variant is the retry framing.
 */
const OR_TTS_ASK = (text: string) => `Read this aloud exactly: ${text}`;
const OR_TTS_ASK_STRICT = (text: string) =>
  `Repeat the following sentence word for word, adding nothing: "${text}"`;

/** Word-overlap check: the streamed transcript must reproduce most of the line's words. */
function speechMatches(expected: string, heard: string): boolean {
  const words = (s: string) =>
    s
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[^a-z0-9\s']/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  const want = words(expected);
  if (!want.length) return true;
  const bag = new Map<string, number>();
  for (const w of words(heard)) bag.set(w, (bag.get(w) ?? 0) + 1);
  let hit = 0;
  for (const w of want) {
    const n = bag.get(w) ?? 0;
    if (n > 0) {
      bag.set(w, n - 1);
      hit++;
    }
  }
  return hit / want.length >= 0.8;
}

interface OpenRouterAudio {
  pcm: Float32Array;
  transcript: string;
}

/** Options for a long-running synthesis — cooperative cancellation + progress. */
export interface SynthesizeOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/** Throws a recognisable AbortError so callers can tell cancel from failure. */
function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

async function requestOpenRouterAudio(
  key: string,
  model: string,
  voice: string,
  text: string,
  strict: boolean,
  signal?: AbortSignal
): Promise<OpenRouterAudio> {
  throwIfAborted(signal);
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://brewlm.app",
      "X-Title": "BrewLM",
    },
    body: JSON.stringify({
      model,
      // audio output is only delivered via SSE chunks
      stream: true,
      modalities: ["text", "audio"],
      audio: { voice, format: "pcm16" },
      messages: [{ role: "user", content: (strict ? OR_TTS_ASK_STRICT : OR_TTS_ASK)(text) }],
    }),
    signal,
  });
  if (!resp.ok) {
    const raw = await resp.text();
    let detail = raw.slice(0, 160);
    try {
      detail = (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? detail;
    } catch {
      /* keep raw */
    }
    if (/modalit|no endpoints|not a valid model/i.test(detail))
      throw new Error(
        `“${model}” can't generate audio on OpenRouter — use an audio-output model there (e.g. ${DEFAULT_TTS_MODELS.openrouter}). Pick one in Settings → Audio voices.`
      );
    throw new Error(`OpenRouter TTS HTTP ${resp.status}: ${detail}`);
  }
  if (!resp.body) throw new Error("OpenRouter TTS: empty response body");
  let b64 = "";
  let transcript = "";
  for await (const payload of sseLines(resp.body)) {
    if (payload === "[DONE]") break;
    try {
      const json = JSON.parse(payload);
      const a = json.choices?.[0]?.delta?.audio;
      if (a?.data) b64 += a.data as string;
      if (a?.transcript) transcript += a.transcript as string;
    } catch {
      // partial JSON chunk — ignore
    }
  }
  if (!b64)
    throw new Error(`Model returned no audio — is "${model}" an audio-output model on OpenRouter?`);
  return { pcm: pcm16Base64ToFloat32(b64), transcript };
}

/**
 * Speak one script line, verifying the streamed transcript against it.
 * gpt-audio likes to improvise its own reply instead of reading — retry once
 * with stricter framing, then give up (mismatched audio is worse than none).
 */
async function speakScriptLine(
  key: string,
  model: string,
  voice: string,
  text: string,
  signal?: AbortSignal
): Promise<Float32Array> {
  let lastTranscript = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    throwIfAborted(signal);
    const { pcm, transcript } = await requestOpenRouterAudio(key, model, voice, text, attempt === 1, signal);
    if (speechMatches(text, transcript)) return pcm;
    lastTranscript = transcript;
  }
  throw new Error(
    `The OpenRouter audio model improvised instead of reading the script (heard: “${lastTranscript.slice(0, 80) || "nothing"}”). ` +
      "gpt-audio can't be trusted to follow a script — switch to OpenAI (gpt-4o-mini-tts) or ElevenLabs in Settings → Audio voices."
  );
}

/** Encode mono float samples as a 16-bit PCM wav file. */
function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true); // pcm chunk size
  v.setUint16(20, 1, true); // pcm
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Uint8Array(buf);
}

/** Parse a raw LLM script into speaker turns (Alex/Sam); capped at 24 turns. */
export function parseScript(raw: string): ScriptTurn[] {
  const turns: ScriptTurn[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*[*-]?\s*(Alex|Sam)\s*:\s*(.+?)\s*$/i);
    if (m && m[2].trim()) {
      turns.push({
        speaker: m[1].toLowerCase() === "sam" ? "Sam" : "Alex",
        text: m[2].replace(/\*\*/g, "").trim(),
      });
    }
  }
  return turns.slice(0, 24);
}

export function chunksToBase64(chunks: Uint8Array[]): string {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  let bin = "";
  const STEP = 0x8000;
  for (let i = 0; i < out.length; i += STEP) {
    bin += String.fromCharCode(...out.subarray(i, i + STEP));
  }
  return btoa(bin);
}

/**
 * Turn a script (solo narration or two-host conversation) into one
 * concatenated audio file, using the TTS provider configured in Settings →
 * Audio voices. Returns a note (not an error) when synthesis is unavailable,
 * so the caller can still keep the script.
 * `opts.signal` cancels mid-synthesis (an AbortError propagates).
 */
export async function synthesizeScript(
  turns: ScriptTurn[],
  settings: Settings,
  opts: SynthesizeOptions = {}
): Promise<TtsResult> {
  const { signal, onProgress } = opts;
  throwIfAborted(signal);
  switch (settings.ttsProvider) {
    case "system":
      return {
        audio: null,
        note: "TTS provider is “System voices” — play the script in-app, or switch to OpenAI / ElevenLabs in Settings → Audio voices for a downloadable mp3.",
      };
    case "openai": {
      const key = settings.openaiTtsKey.trim() || settings.openaiKey;
      if (!key)
        return { audio: null, note: "Add an OpenAI TTS key in Settings → Audio voices to synthesize audio." };
      const model = settings.ttsModel.trim() || DEFAULT_TTS_MODELS.openai;
      const voices = {
        Alex: settings.ttsVoiceAlex.trim() || OPENAI_VOICE_DEFAULTS.Alex,
        Sam: settings.ttsVoiceSam.trim() || OPENAI_VOICE_DEFAULTS.Sam,
      };
      const instructions = settings.ttsInstructions.trim();
      const parts: Uint8Array[] = [];
      for (let i = 0; i < turns.length; i++) {
        throwIfAborted(signal);
        onProgress?.(i, turns.length);
        const resp = await fetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            input: turns[i].text,
            voice: voices[turns[i].speaker],
            response_format: "mp3",
            ...(instructions ? { instructions } : {}),
          }),
          signal,
        });
        if (!resp.ok)
          throw new Error(`OpenAI TTS HTTP ${resp.status}: ${(await resp.text()).slice(0, 140)}`);
        parts.push(new Uint8Array(await resp.arrayBuffer()));
      }
      return { audio: `data:audio/mpeg;base64,${chunksToBase64(parts)}` };
    }
    /**
     * OpenRouter: audio output via **streaming** chat completions — OpenRouter
     * only routes OpenAI's audio models (gpt-audio / gpt-audio-mini), and
     * delivers audio exclusively as base64 pcm16 in `delta.audio.data` SSE
     * chunks. Turns are merged and wrapped in one wav header at the end.
     * A steering system message makes the (conversational) model read verbatim.
     */
    case "openrouter": {
      const key = settings.openrouterTtsKey.trim() || settings.openrouterKey;
      if (!key)
        return { audio: null, note: "Add an OpenRouter key in Settings → Audio voices to synthesize audio." };
      const model = settings.ttsModel.trim() || DEFAULT_TTS_MODELS.openrouter;
      const voices = {
        Alex: settings.ttsVoiceAlex.trim() || OPENROUTER_VOICE_DEFAULTS.Alex,
        Sam: settings.ttsVoiceSam.trim() || OPENROUTER_VOICE_DEFAULTS.Sam,
      };
      const clips: Float32Array[] = [];
      for (let i = 0; i < turns.length; i++) {
        throwIfAborted(signal);
        onProgress?.(i, turns.length);
        clips.push(await speakScriptLine(key, model, voices[turns[i].speaker], turns[i].text, signal));
      }
      const total = clips.reduce((n, c) => n + c.length, 0);
      const merged = new Float32Array(total);
      let off = 0;
      for (const c of clips) {
        merged.set(c, off);
        off += c.length;
      }
      return { audio: `data:audio/wav;base64,${chunksToBase64([encodeWavPcm16(merged, PCM16_RATE)])}` };
    }
    case "elevenlabs": {
      const key = settings.elevenlabsKey.trim();
      if (!key)
        return { audio: null, note: "Add an ElevenLabs API key in Settings → Audio voices to synthesize audio." };
      const voices = {
        Alex: settings.ttsVoiceAlex.trim(),
        Sam: settings.ttsVoiceSam.trim(),
      };
      if (!voices.Alex || (turns.some((t) => t.speaker === "Sam") && !voices.Sam))
        return { audio: null, note: "Set the host voice IDs (Settings → Audio voices) — ElevenLabs needs a voice ID for every speaker in the script." };
      const model = settings.ttsModel.trim() || DEFAULT_TTS_MODELS.elevenlabs;
      const parts: Uint8Array[] = [];
      for (let i = 0; i < turns.length; i++) {
        throwIfAborted(signal);
        onProgress?.(i, turns.length);
        const voiceId = voices[turns[i].speaker];
        const resp = await tauriFetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
          {
            method: "POST",
            headers: {
              "xi-api-key": key,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              text: turns[i].text,
              model_id: model,
              voice_settings: { stability: 0.5, similarity_boost: 0.75 },
            }),
          }
        );
        if (!resp.ok)
          throw new Error(`ElevenLabs HTTP ${resp.status}: ${(await resp.text()).slice(0, 140)}`);
        parts.push(new Uint8Array(await resp.arrayBuffer()));
      }
      return { audio: `data:audio/mpeg;base64,${chunksToBase64(parts)}` };
    }
    default:
      return { audio: null, note: "Unknown TTS provider — check Settings → Audio voices." };
  }
}
