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
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  canEncodeAudio,
  Mp4OutputFormat,
  Output,
  Quality,
} from "mediabunny";

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
