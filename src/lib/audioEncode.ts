/**
 * Speech audio compression: PCM → AAC in an .m4a file.
 *
 * Audio overviews from OpenRouter's audio models arrive as raw 24 kHz PCM and
 * used to be saved as WAV (~2.9 MB per minute). AAC at 64 kbps is ~0.5 MB per
 * minute with no audible loss for speech, plays everywhere (Safari/WebKit,
 * WebView2, phones), and seeks properly thanks to the MP4 index.
 *
 * Encoding uses the platform's WebCodecs AAC encoder (Mediabunny muxes the
 * file). Where no encoder exists the callers keep WAV — nothing breaks, the
 * file is just bigger.
 */
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  canEncodeAudio,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
} from "mediabunny";
import { encodeWav } from "./audioClips";

const SPEECH_BITRATE = 64_000;
/**
 * Plain AAC-LC. Left to choose, Mediabunny picks HE-AAC for ≤24 kHz input, and
 * WebKit's HE-AAC output is malformed (CoreAudio can't decode it, players
 * stall and report double the duration).
 */
const AAC_LC = "mp4a.40.2";

/** Encode mono float samples as AAC/.m4a. Null when this platform can't encode AAC. */
export async function encodeM4a(samples: Float32Array, sampleRate: number): Promise<Uint8Array | null> {
  const supported = await canEncodeAudio("aac", {
    numberOfChannels: 1,
    sampleRate,
    bitrate: SPEECH_BITRATE,
    fullCodecString: AAC_LC,
  }).catch(() => false);
  if (!supported) return null;

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "in-memory" }),
    target: new BufferTarget(),
  });
  const source = new AudioSampleSource({
    codec: "aac",
    fullCodecString: AAC_LC,
    quality: new Quality({ bitrate: SPEECH_BITRATE }),
  });
  output.addAudioTrack(source);
  await output.start();
  // One-second slices: the encoder applies backpressure through add(). Each
  // slice is a copy — Mediabunny hands the whole underlying buffer to the
  // encoder, ignoring a subarray's offset (every second would repeat the first).
  for (let i = 0; i < samples.length; i += sampleRate) {
    const sample = new AudioSample({
      data: samples.slice(i, Math.min(samples.length, i + sampleRate)),
      format: "f32",
      numberOfChannels: 1,
      sampleRate,
      timestamp: i / sampleRate,
    });
    await source.add(sample);
    sample.close();
  }
  source.close();
  await output.finalize();
  const buf = (output.target as BufferTarget).buffer;
  return buf ? new Uint8Array(buf) : null;
}

/** Mono 16-bit PCM samples of a WAV file (the format tts.ts writes). Null for anything else. */
export function decodeWavPcm16(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let sampleRate = 0;
  let pcmMono16 = false;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = tag(at);
    const size = v.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      const format = v.getUint16(body, true);
      const channels = v.getUint16(body + 2, true);
      sampleRate = v.getUint32(body + 4, true);
      pcmMono16 = format === 1 && channels === 1 && v.getUint16(body + 14, true) === 16;
    } else if (id === "data") {
      if (!pcmMono16 || !sampleRate) return null;
      const n = Math.floor(Math.min(size, bytes.length - body) / 2);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = v.getInt16(body + i * 2, true) / 32768;
      return { samples, sampleRate };
    }
    at = body + size + (size % 2); // chunks are word-aligned
  }
  return null;
}

/** WAV bytes → .m4a bytes, or null if the WAV isn't ours or AAC is unavailable. */
export async function compressWav(wav: Uint8Array): Promise<Uint8Array | null> {
  const pcm = decodeWavPcm16(wav);
  return pcm ? encodeM4a(pcm.samples, pcm.sampleRate) : null;
}

/* ------------------------------- recordings -------------------------------- */

/**
 * Added recordings (lectures, meetings, voice memos, and the soundtrack of
 * videos) are kept as mono speech AAC: ~0.36 MB per minute, so a 50-minute,
 * 100 MB video becomes ~18 MB. 44.1 kHz because Mediabunny's conversion picks
 * HE-AAC at ≤24 kHz, which WebKit encodes badly (see AAC_LC), and Chromium's
 * AAC encoder only takes 44.1/48 kHz. 48 kbps because macOS's AAC encoder
 * fails on mono 44.1 kHz below ~40 kbps.
 */
const RECORDING_BITRATE = 48_000;
const RECORDING_SAMPLE_RATE = 44_100;
/** Mono AAC at or below this is already compact and is kept as-is. */
const COMPACT_BITRATE = 64_000;

export interface Recording {
  /** An .m4a file. */
  bytes: Uint8Array;
  /** Seconds. */
  duration: number;
}

const speechAudio = {
  numberOfChannels: 1,
  sampleRate: RECORDING_SAMPLE_RATE,
  codec: "aac",
  quality: new Quality({ bitrate: RECORDING_BITRATE }),
} as const;

async function convert(src: Blob, trim?: { start: number; end: number }): Promise<Uint8Array | null> {
  const input = new Input({ source: new BlobSource(src), formats: ALL_FORMATS });
  try {
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target: new BufferTarget(),
    });
    const conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      video: { discard: true },
      audio: speechAudio,
      trim,
      showWarnings: false,
    });
    if (!conversion.isValid || conversion.utilizedTracks.length === 0) return null;
    await conversion.execute();
    const buf = (output.target as BufferTarget).buffer;
    return buf ? new Uint8Array(buf) : null;
  } finally {
    input.dispose();
  }
}

/**
 * Any audio or video file → its soundtrack as mono speech .m4a; the video
 * track is dropped. Null when the file has no readable soundtrack or this
 * platform can't decode or encode it (callers then fall back to the original).
 */
export async function compressRecording(file: Blob): Promise<Recording | null> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  let duration: number;
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return null;
    duration = await track.computeDuration();
    // Already small mono AAC (a stored recording being re-transcribed): re-encoding would only lose quality.
    if (track.codec === "aac" && track.numberOfChannels === 1 && duration > 0 && (file.size * 8) / duration <= COMPACT_BITRATE)
      return { bytes: new Uint8Array(await file.arrayBuffer()), duration };
  } catch {
    return null;
  } finally {
    input.dispose();
  }
  const supported = await canEncodeAudio("aac", {
    numberOfChannels: 1,
    sampleRate: RECORDING_SAMPLE_RATE,
    bitrate: RECORDING_BITRATE,
  }).catch(() => false);
  if (!supported) return null;
  const bytes = await convert(file).catch((e) => {
    console.warn("audio: couldn't compress recording", e);
    return null;
  });
  return bytes ? { bytes, duration } : null;
}

/** Cut a recording into consecutive pieces of at most `seconds` each. */
export async function splitRecording(rec: Recording, seconds: number): Promise<Uint8Array[]> {
  if (rec.duration <= seconds) return [rec.bytes];
  const whole = new Blob([rec.bytes], { type: "audio/mp4" });
  const pieces: Uint8Array[] = [];
  for (let start = 0; start < rec.duration; start += seconds) {
    const piece = await convert(whole, { start, end: Math.min(rec.duration, start + seconds) });
    if (!piece) throw new Error("couldn't split the recording");
    pieces.push(piece);
  }
  return pieces;
}

/* --------------------------- for local transcription --------------------------- */

/** What Whisper-family models listen at; sending more is wasted bytes. */
export const TRANSCRIBE_SAMPLE_RATE = 16_000;

/**
 * Any audio the platform can decode → 16 kHz mono 16-bit WAV, the one format
 * every local transcription server takes (whisper.cpp's server takes only
 * WAV unless started with --convert). Null when it can't be decoded here;
 * callers then send the original.
 */
export async function toTranscribeWav(audio: Blob): Promise<Uint8Array | null> {
  const Ctx = globalThis.OfflineAudioContext;
  if (!Ctx) return null;
  try {
    // decodeAudioData resamples to the context's rate; one channel downmixes.
    const probe = new Ctx(1, 1, TRANSCRIBE_SAMPLE_RATE);
    const decoded = await probe.decodeAudioData(await audio.arrayBuffer());
    const frames = Math.ceil(decoded.duration * TRANSCRIBE_SAMPLE_RATE);
    if (!frames) return null;
    const ctx = new Ctx(1, frames, TRANSCRIBE_SAMPLE_RATE);
    const src = ctx.createBufferSource();
    src.buffer = decoded;
    src.connect(ctx.destination);
    src.start();
    const rendered = await ctx.startRendering();
    return encodeWav(rendered.getChannelData(0), TRANSCRIBE_SAMPLE_RATE);
  } catch (e) {
    console.warn("audio: couldn't convert to WAV for local transcription", e);
    return null;
  }
}
