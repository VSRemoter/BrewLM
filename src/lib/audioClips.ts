/**
 * Telling speech-server replies apart and reading WAV ones. Local speech
 * servers answer in whatever format they like (Kokoro: mp3; Piper via
 * LocalAI: wav), whatever was asked for. mp3 clips join end to end; wav clips
 * are decoded so they can be merged and encoded once.
 */

export type ClipFormat = "mp3" | "wav" | "unknown";

/** The clip's format from its first bytes. */
export function sniffAudio(bytes: Uint8Array): ClipFormat {
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return "wav";
  if (bytes.length >= 3 && ascii(bytes, 0, 3) === "ID3") return "mp3";
  // A bare MPEG audio frame: 11 sync bits set.
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "mp3";
  return "unknown";
}

function ascii(b: Uint8Array, at: number, n: number): string {
  return String.fromCharCode(...b.subarray(at, at + n));
}

/**
 * 16-bit PCM WAV → mono float samples and their rate. Stereo is averaged.
 * Throws on anything else (float, 8-bit, compressed).
 */
export function parseWav(bytes: Uint8Array): { samples: Float32Array; rate: number } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 12;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  let format = 0;
  while (off + 8 <= bytes.length) {
    const id = ascii(bytes, off, 4);
    let size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      format = v.getUint16(body, true);
      channels = v.getUint16(body + 2, true);
      rate = v.getUint32(body + 4, true);
      bits = v.getUint16(body + 14, true);
    } else if (id === "data") {
      // Streaming servers write 0 or 0xFFFFFFFF when they don't know the length yet.
      if (size === 0 || body + size > bytes.length) size = bytes.length - body;
      // 1 = PCM; 0xFFFE = extensible, which servers use for plain PCM too.
      if ((format !== 1 && format !== 0xfffe) || bits !== 16 || channels < 1)
        throw new Error("the speech server sent a WAV format BrewLM can't read (only 16-bit PCM)");
      const frames = Math.floor(size / (2 * channels));
      const samples = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += v.getInt16(body + (i * channels + c) * 2, true);
        samples[i] = sum / channels / 32768;
      }
      return { samples, rate };
    }
    off = body + size + (size % 2); // chunks are word-aligned
  }
  throw new Error("the speech server sent a WAV file with no audio in it");
}

/** Many mono float clips → one. */
export function joinSamples(clips: Float32Array[]): Float32Array {
  const out = new Float32Array(clips.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of clips) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Mono float samples → a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, t: string) => {
    for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i));
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
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(off, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    off += 2;
  }
  return new Uint8Array(buf);
}
