/**
 * Makes image and audio/video sources readable by the model. The chat model
 * only ever sees text, so at ingest time each media file is converted once:
 * images → a detailed description plus verbatim OCR (vision model), audio and
 * video → a transcript (speech-to-text). The result is stored in
 * `sources.text` and flows through retrieval like any other source text.
 *
 * Each job has its own "Runs on" choice (featureRoute.ts). On Automatic with a
 * cloud chat provider, whichever configured key can do the job is used, with
 * small fixed models known to support the modality (so a text-only chat model
 * never breaks ingestion). With a local chat model, Automatic means this
 * computer only: a local vision model reads images, and nothing is sent to a
 * cloud key that happens to be saved.
 */

import { platform } from "../platform";
import { compressRecording, type Recording, splitRecording } from "./audioEncode";
import { isBlobRef, isMediaValue, mediaBlob } from "./blobs";
import { setSourceContent, setSourceText, sourceText, updateSource } from "./db";
import type { StreamUsage } from "./llm";
import { openRouterPrefs, routingError } from "./routing";
import { aiConfigNow, brewlmSession, openRouterApi, planHasAi, speaksOpenRouter } from "./brewlmAi";
import { cloudJobsWhileLocal, featureProviders, type MediaFeature, staysLocal } from "./featureRoute";
import { localHeaders, normalizeBaseUrl } from "./local";
import { loadOpenRouterCatalog } from "./modelLimits";
import { loadSettings } from "./settings";
import type { Provider, Settings, Source } from "./types";
import { recordUsage } from "./usage";
import { fetchYouTubeTranscript, isYouTubeUrl, YOUTUBE_PENDING } from "./youtube";

const VISION_MODELS: Record<Provider, string> = {
  brewlm: "", // the config's transcription model (visionModel), which reads images too
  openai: "gpt-4o-mini",
  openrouter: "google/gemini-2.5-flash",
  anthropic: "claude-haiku-4-5-20251001",
  local: "", // the user's pick: Settings → Local models → Image reading
};
const OPENROUTER_AUDIO_MODEL = "google/gemini-2.5-flash";

function visionModel(s: Settings, p: Provider): string {
  if (p === "local") return s.localVisionModel.trim();
  return p === "brewlm" ? aiConfigNow().roles.transcribe : VISION_MODELS[p];
}

/** Local vision models get a smaller picture: it fits small context windows and reads faster on a laptop. */
const LOCAL_IMAGE_SIDE = 1280;
/** Cap on what a local model writes about one image (it's the whole reply, so generous but bounded). */
const LOCAL_VISION_MAX_TOKENS = 2048;
const OPENAI_TRANSCRIBE_MODELS = ["gpt-4o-mini-transcribe", "whisper-1"];
/** What "Automatic" means in Settings → Transcription model, per provider. */
export const AUTO_TRANSCRIBE_MODEL: Partial<Record<Provider, string>> = {
  openai: OPENAI_TRANSCRIBE_MODELS[0],
  openrouter: OPENROUTER_AUDIO_MODEL,
};
/** OpenAI's transcription upload cap; OpenRouter requests are kept under it too. */
const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024;
/** Long recordings are transcribed in pieces this long (~7 MB each once compressed). */
const CHUNK_SECONDS = 20 * 60;
const MAX_TEXT_CHARS = 200_000;

const IMAGE_PROMPT = `You are preparing an image so a study assistant that cannot see it can answer any question about it.
1. "Text in image": transcribe ALL visible text verbatim (printed, handwritten, labels, captions, code), preserving structure — headings, lists, and tables as markdown. Write "none" if there is no text.
2. "Visual description": describe everything else in detail — diagrams (every node, arrow, and label), charts (type, axes, units, values, trends), equations (as LaTeX), photos, layout.
3. "Key points": 2-5 bullets on what the image conveys.
Only describe what is actually visible; don't speculate.`;

const TRANSCRIBE_PROMPT =
  "Transcribe this audio verbatim. Mark speaker changes when they are clear (Speaker 1:, Speaker 2:). Output only the transcript, no commentary.";

/** `content` of an audio source whose recording was dropped after transcription (Settings → keep recordings off). */
export const TRANSCRIPT_ONLY = "[recording not kept — transcript only]";

export interface MediaResult {
  text: string;
  /** Why the model can't read this file (shown to the user), when text is "". */
  warning?: string;
}

/* ---------------------------------- keys ---------------------------------- */

function keyFor(s: Settings, p: Provider): string {
  switch (p) {
    // BrewLM AI reads media for anyone whose plan includes it, whatever chat runs on.
    case "brewlm":
      return planHasAi() ? brewlmSession() : "";
    case "openai":
      return s.openaiKey || s.openaiTtsKey;
    case "openrouter":
      return s.openrouterKey || s.openrouterTtsKey;
    case "anthropic":
      return s.anthropicKey;
    case "local":
      return s.localKey;
  }
}

const hasKeyIn = (s: Settings) => (p: Provider) => p !== "local" && !!keyFor(s, p);

/** Providers to try for a job, in order, per its "Runs on" choice ([] = nothing set up). */
export function mediaProviders(s: Settings, f: MediaFeature): Provider[] {
  return featureProviders(s, f, hasKeyIn(s));
}

/** With a local chat model: the jobs that would still reach a cloud service (chat footer). */
export function cloudJobs(s: Settings): string[] {
  return cloudJobsWhileLocal(s, hasKeyIn(s));
}

function cap(text: string): string {
  const t = text.trim();
  return t.length > MAX_TEXT_CHARS ? t.slice(0, MAX_TEXT_CHARS) + "\n\n[Truncated]" : t;
}

async function failure(res: Response): Promise<Error> {
  let detail = "";
  try {
    detail = (await res.text()).slice(0, 300);
  } catch {
    /* ignore */
  }
  return new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
}

/* --------------------------------- images --------------------------------- */

/**
 * Re-encode as a ≤1600px JPEG: every vision API accepts it (HEIC/TIFF/BMP/SVG
 * don't travel well), it stays far below per-image size caps, and it keeps
 * token cost down while leaving text legible for OCR.
 */
function toVisionJpeg(src: Blob | string, maxSide = 1600): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = typeof src === "string" ? src : URL.createObjectURL(src);
    const img = new Image();
    const done = () => {
      if (typeof src !== "string") URL.revokeObjectURL(url);
    };
    img.onload = () => {
      done();
      const w = img.naturalWidth || 1024;
      const h = img.naturalHeight || 1024;
      const scale = Math.min(1, maxSide / Math.max(w, h));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("Canvas is unavailable."));
      // White matte: transparent PNG/SVG regions would otherwise turn black.
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.9));
    };
    img.onerror = () => {
      done();
      reject(new Error("this image format couldn't be decoded"));
    };
    img.src = url;
  });
}

/** One image and one instruction to the local server's chat endpoint. */
async function localVisionCall(s: Settings, jpeg: string, prompt: string): Promise<{ text: string; usage: StreamUsage }> {
  const base = normalizeBaseUrl(s.localBaseUrl);
  const model = s.localVisionModel.trim();
  if (!base) throw new Error("no local server address is set");
  if (!model) throw new Error("no local vision model is picked");
  let res: Response;
  try {
    res = await platform.fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: localHeaders(s.localKey),
      body: JSON.stringify({
        model,
        max_tokens: LOCAL_VISION_MAX_TOKENS,
        stream: false,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: jpeg } },
            ],
          },
        ],
      }),
      connectTimeout: 10000,
    });
  } catch {
    throw new Error(`couldn't reach your local server at ${base}. Is it running?`);
  }
  if (!res.ok) {
    const err = await failure(res);
    throw new Error(`${err.message}. Check that “${model}” can read images`);
  }
  return readCompletion(await res.json());
}

async function visionCall(s: Settings, p: Provider, jpeg: string): Promise<string> {
  const key = keyFor(s, p);
  const model = visionModel(s, p);
  let usage: StreamUsage = {};
  let text = "";
  if (p === "local") {
    const out = await localVisionCall(s, jpeg, IMAGE_PROMPT);
    text = out.text;
    usage = out.usage;
  } else if (p === "anthropic") {
    const res = await platform.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/jpeg", data: jpeg.split(",")[1] },
              },
              { type: "text", text: IMAGE_PROMPT },
            ],
          },
        ],
      }),
      connectTimeout: 30000,
    });
    if (!res.ok) throw await failure(res);
    const json = await res.json();
    text = (json?.content ?? [])
      .filter((b: { type?: string }) => b?.type === "text")
      .map((b: { text?: string }) => b.text ?? "")
      .join("");
    usage = { input: json?.usage?.input_tokens, output: json?.usage?.output_tokens };
  } else {
    const json = await chatCompletion(p, key, model, [
      { type: "text", text: IMAGE_PROMPT },
      { type: "image_url", image_url: { url: jpeg } },
    ]);
    text = json.text;
    usage = json.usage;
  }
  void recordUsage("sources", p, model, usage);
  return text;
}

/** OpenAI-compatible, non-streaming, one multimodal user turn. */
async function chatCompletion(
  p: Provider,
  key: string,
  model: string,
  content: unknown[]
): Promise<{ text: string; usage: StreamUsage }> {
  const or = speaksOpenRouter(p) ? openRouterApi(p, key) : null;
  const url = or ? `${or.base}/chat/completions` : "https://api.openai.com/v1/chat/completions";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${or?.key ?? key}`,
    ...or?.headers,
  };
  const body: Record<string, unknown> = { model, max_tokens: 8192, messages: [{ role: "user", content }] };
  if (p === "openrouter") {
    const prefs = await openRouterPrefs(model);
    if (prefs) body.provider = prefs;
  }
  const res = await platform.fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    connectTimeout: 30000,
  });
  if (!res.ok) {
    const err = await failure(res);
    throw p === "openrouter" ? new Error((await routingError(err.message, model)) || err.message) : err;
  }
  return readCompletion(await res.json());
}

/** Text and token counts from a non-streaming chat-completions reply. */
function readCompletion(json: any): { text: string; usage: StreamUsage } { // eslint-disable-line @typescript-eslint/no-explicit-any
  const msg = json?.choices?.[0]?.message?.content;
  const text = Array.isArray(msg)
    ? msg.map((part: { text?: string }) => part?.text ?? "").join("")
    : String(msg ?? "");
  return {
    text,
    usage: {
      input: json?.usage?.prompt_tokens,
      output: json?.usage?.completion_tokens,
      costUsd: typeof json?.usage?.cost === "number" ? json.usage.cost : undefined,
    },
  };
}

/** Image (File or data URL) → description + OCR text. Never throws. */
export async function describeImage(src: Blob | string, settings?: Settings): Promise<MediaResult> {
  const s = settings ?? (await loadSettings());
  const providers = mediaProviders(s, "vision");
  if (providers.length === 0)
    return {
      text: "",
      warning: staysLocal(s, "vision")
        ? "pick a vision model in Settings → Local models so it can be read on this computer — it will be described automatically before your next question. Nothing is sent to the cloud while you use a local model."
        : s.visionRunsOn !== "auto"
          ? "the provider chosen for image reading in Settings → Local models has no key yet. Add one, or switch image reading back to Automatic."
          : "add an API key in Settings so the AI can read images — it will be described automatically before your next question.",
    };
  let jpeg: string;
  try {
    jpeg = await toVisionJpeg(src, providers[0] === "local" ? LOCAL_IMAGE_SIDE : undefined);
  } catch (e) {
    return { text: "", warning: e instanceof Error ? e.message : String(e) };
  }
  let lastErr = "";
  for (const p of providers) {
    try {
      const text = cap(await visionCall(s, p, jpeg));
      if (text) return { text: `[Image contents, as read by ${visionModel(s, p)}]\n\n${text}` };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  return { text: "", warning: `couldn't analyze the image (${lastErr || "empty response"}).` };
}

/** A small picture of known text, drawn here, so the vision test needs no file. */
function testCardJpeg(code: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 200;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable.");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  ctx.font = "bold 72px Helvetica, Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(code, canvas.width / 2, canvas.height / 2);
  return canvas.toDataURL("image/jpeg", 0.92);
}

export type VisionTest = { ok: true; seconds: number } | { ok: false; message: string };

/**
 * Settings → Local models → Test: shows the local vision model a picture of a
 * random number and checks it reads the number back.
 */
export async function testLocalVision(s: Settings): Promise<VisionTest> {
  const code = String(Math.floor(100 + Math.random() * 900));
  const started = Date.now();
  try {
    const { text } = await localVisionCall(
      s,
      testCardJpeg(code),
      "What number is written in this image? Reply with the number only."
    );
    if (text.replace(/\D/g, "").includes(code)) return { ok: true, seconds: Math.round((Date.now() - started) / 1000) };
    return {
      ok: false,
      message: text.trim()
        ? `It answered “${text.trim().slice(0, 80)}” instead of ${code}, so it probably can't read images. Try a vision model such as qwen2.5vl, gemma3 or llava.`
        : "It sent back an empty answer, so it probably can't read images. Try a vision model such as qwen2.5vl, gemma3 or llava.",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: msg.charAt(0).toUpperCase() + msg.slice(1) + "." };
  }
}

/* ------------------------------ audio / video ------------------------------ */

function extOf(name: string, mime: string): string {
  const fromName = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (fromName) return fromName;
  const sub = mime.split("/")[1]?.split(";")[0] ?? "mp3";
  return sub === "mpeg" ? "mp3" : sub === "x-m4a" || sub === "mp4" ? "m4a" : sub;
}

/** The user's pick first (if any), then the automatic models — a retired or failing pick never blocks transcription. */
function withPick(pick: string | undefined, auto: string[]): string[] {
  const p = pick?.trim();
  return p ? [p, ...auto.filter((m) => m !== p)] : auto;
}

async function openAiTranscribe(key: string, blob: Blob, filename: string, pick?: string): Promise<string> {
  let lastErr: Error | null = null;
  // gpt-4o-mini-transcribe is cheaper and more accurate but caps duration;
  // whisper-1 takes anything under the byte limit.
  for (const model of withPick(pick, OPENAI_TRANSCRIBE_MODELS)) {
    const form = new FormData();
    form.append("file", blob, filename);
    form.append("model", model);
    form.append("response_format", "json");
    const res = await platform.fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      connectTimeout: 30000,
    });
    if (!res.ok) {
      lastErr = await failure(res);
      if (res.status === 401) break;
      continue;
    }
    const json = await res.json();
    void recordUsage("sources", "openai", model, {
      input: json?.usage?.input_tokens,
      output: json?.usage?.output_tokens,
    });
    return String(json?.text ?? "");
  }
  throw lastErr ?? new Error("transcription failed");
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** One transcription request: bytes in, transcript out (throws on failure). */
async function transcribeOnce(s: Settings, p: Provider, blob: Blob, filename: string, ext: string): Promise<string> {
  const pick = s.transcribeModels?.[p];
  if (p === "openai") return openAiTranscribe(keyFor(s, p), blob, filename, pick);
  const data = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  let lastErr: unknown = null;
  const models = p === "brewlm" ? [aiConfigNow().roles.transcribe] : withPick(pick, [OPENROUTER_AUDIO_MODEL]);
  for (const model of models) {
    try {
      const out = await chatCompletion(p, keyFor(s, p), model, [
        { type: "text", text: TRANSCRIBE_PROMPT },
        { type: "input_audio", input_audio: { data, format: ext } },
      ]);
      void recordUsage("sources", p, model, out.usage);
      return out.text;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** Providers that can transcribe with the configured keys, in the order they're tried. */
export function transcribeProviders(s: Settings): Provider[] {
  return mediaProviders(s, "transcribe");
}

/**
 * Whether OpenRouter lists this model as taking audio: true/false, or null
 * when it can't tell (OpenAI, catalog unavailable). Settings uses it to flag
 * a typed id that can't transcribe.
 */
export async function acceptsAudio(p: Provider, id: string): Promise<boolean | null> {
  if (p !== "openrouter" || !id.trim()) return null;
  const catalog = await loadOpenRouterCatalog();
  if (!catalog) return null;
  const m = catalog.find((x) => x.id === id.trim());
  return !!m?.architecture?.input_modalities?.includes("audio");
}

function clock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:00` : `${m}:00`;
}

/**
 * Audio/video (File or data URL) → transcript. Never throws.
 *
 * The soundtrack is first compressed to mono speech audio (audioEncode.ts),
 * which drops any video and brings a 50-minute recording from ~100 MB to
 * ~18 MB; that copy is returned as `recording` for the caller to keep. Long
 * recordings are transcribed in CHUNK_SECONDS pieces, which keeps each upload
 * small, within gpt-4o-mini-transcribe's duration cap, and within the
 * OpenRouter model's output limit.
 */
export async function transcribeAudio(
  src: Blob | string,
  filename: string,
  settings?: Settings
): Promise<MediaResult & { recording?: Recording }> {
  const s = settings ?? (await loadSettings());
  const blob = typeof src === "string" ? await (await fetch(src)).blob() : src;
  const recording = (await compressRecording(blob).catch(() => null)) ?? undefined;
  const base = filename.replace(/\.[a-z0-9]+$/i, "") || "recording";
  if (!recording && blob.size > MAX_TRANSCRIBE_BYTES)
    return {
      text: "",
      warning: `too large to transcribe (${(blob.size / 1024 / 1024).toFixed(1)} MB; the limit is 25 MB) and its audio couldn't be extracted on this device — split or compress it, then re-add.`,
    };
  const providers = transcribeProviders(s);
  if (providers.length === 0)
    return {
      text: "",
      recording,
      warning: staysLocal(s, "transcribe")
        ? "transcription doesn't run on this computer yet, and nothing is sent to the cloud while you use a local model. To transcribe it, pick a cloud provider for Transcription in Settings → Local models."
        : s.transcribeRunsOn !== "auto"
          ? "the provider chosen for transcription in Settings → Local models has no key yet. Add one, or switch transcription back to Automatic."
          : "transcribing audio needs an OpenAI or OpenRouter key (Anthropic models can't hear audio). Add one in Settings and it will be transcribed automatically before your next question.",
    };
  let pieces: Blob[];
  let ext: string;
  let name: string;
  if (recording) {
    try {
      pieces = (await splitRecording(recording, CHUNK_SECONDS)).map((b) => new Blob([b], { type: "audio/mp4" }));
    } catch (e) {
      return { text: "", recording, warning: `couldn't prepare it for transcription (${e instanceof Error ? e.message : String(e)}).` };
    }
    ext = "m4a";
    name = `${base}.m4a`;
  } else {
    pieces = [blob];
    ext = extOf(filename, blob.type);
    name = filename.includes(".") ? filename : `${filename}.${ext}`;
  }
  const parts: string[] = [];
  for (let i = 0; i < pieces.length; i++) {
    let lastErr = "";
    let text = "";
    for (const p of providers) {
      try {
        text = (await transcribeOnce(s, p, pieces[i], name, ext)).trim();
        if (text) break;
        lastErr = "no speech detected";
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
    // A partial transcript would read as the whole recording; fail it and retry later instead.
    if (!text && pieces.length > 1 && lastErr !== "no speech detected")
      return { text: "", recording, warning: `couldn't transcribe part ${i + 1} of ${pieces.length} (${lastErr}).` };
    if (!text && pieces.length === 1) return { text: "", recording, warning: `couldn't transcribe it (${lastErr}).` };
    if (text) parts.push(pieces.length > 1 ? `[${clock(i * CHUNK_SECONDS)}]\n${text}` : text);
  }
  const text = cap(parts.join("\n\n"));
  return text ? { text: `[Transcript]\n\n${text}`, recording } : { text: "", recording, warning: "couldn't transcribe it (no speech detected)." };
}

/* --------------------------------- backfill -------------------------------- */

/** One attempt per source per app session — a failing key never storms. */
const attempted = new Set<string>();

/**
 * Before retrieval: give unreadable sources their text. Covers media added
 * before this existed, media added while no suitable key was configured, and
 * YouTube links queued from the phone. Mutates the passed Source objects so
 * the caller's current prompt already sees the new text.
 */
export async function ensureMediaText(sources: Source[], settings?: Settings): Promise<void> {
  const pending = sources.filter(
    (s) =>
      !attempted.has(s.id) &&
      (((s.type === "image" || s.type === "audio") &&
        !sourceText(s) &&
        isMediaValue(s.content)) ||
        (s.type === "link" && s.content === YOUTUBE_PENDING && isYouTubeUrl(s.mime ?? "")))
  );
  if (pending.length === 0) return;
  const st = settings ?? (await loadSettings());
  for (const src of pending) {
    // Nothing set up to read it yet: try again once something is, without a restart.
    if (src.type !== "link" && mediaProviders(st, src.type === "image" ? "vision" : "transcribe").length === 0) continue;
    attempted.add(src.id);
    try {
      if (src.type === "link") {
        const { title, text } = await fetchYouTubeTranscript(src.mime ?? "");
        await updateSource(src.id, title, text);
        src.title = title;
        src.content = text;
        continue;
      }
      const media = isBlobRef(src.content) ? await mediaBlob(src.content) : src.content;
      const r =
        src.type === "image"
          ? await describeImage(media, st)
          : await transcribeAudio(media, src.title, st);
      if (!r.text) continue;
      await setSourceText(src.id, r.text);
      src.text = r.text;
      // Kept only so this could be retried; the user asked for transcripts alone.
      if (src.type === "audio" && !st.keepRecordings) {
        await setSourceContent(src.id, TRANSCRIPT_ONLY);
        src.content = TRANSCRIPT_ONLY;
      }
    } catch (e) {
      console.warn("media: couldn't extract", src.title, e);
    }
  }
}
