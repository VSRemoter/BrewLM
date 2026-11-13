import { describe, expect, it } from "vitest";
import { joinSamples, parseWav, sniffAudio } from "./audioClips";

/** A 16-bit PCM WAV built by hand; `dataSize` overrides the header's length field. */
function wav(samples: number[], { rate = 24000, channels = 1, dataSize }: { rate?: number; channels?: number; dataSize?: number } = {}) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2 * channels, true);
  v.setUint16(32, 2 * channels, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, dataSize ?? samples.length * 2, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, s, true));
  return new Uint8Array(buf);
}

describe("sniffAudio", () => {
  it("tells mp3, wav and anything else apart", () => {
    expect(sniffAudio(new Uint8Array([0x49, 0x44, 0x33, 4, 0]))).toBe("mp3"); // "ID3"
    expect(sniffAudio(new Uint8Array([0xff, 0xfb, 0x90, 0]))).toBe("mp3"); // frame sync
    expect(sniffAudio(wav([0, 1]))).toBe("wav");
    expect(sniffAudio(new TextEncoder().encode('{"error":"x"}'))).toBe("unknown");
    expect(sniffAudio(new Uint8Array([]))).toBe("unknown");
  });
});

describe("parseWav", () => {
  it("reads mono 16-bit PCM and its rate", () => {
    const { samples, rate } = parseWav(wav([0, 16384, -32768], { rate: 22050 }));
    expect(rate).toBe(22050);
    expect([...samples]).toEqual([0, 0.5, -1]);
  });

  it("averages stereo to mono", () => {
    const { samples } = parseWav(wav([16384, 0, -16384, -16384], { channels: 2 }));
    expect([...samples]).toEqual([0.25, -0.5]);
  });

  it("reads a streamed WAV whose header doesn't know its length", () => {
    expect(parseWav(wav([100, 200, 300], { dataSize: 0xffffffff })).samples.length).toBe(3);
    expect(parseWav(wav([100, 200], { dataSize: 0 })).samples.length).toBe(2);
  });

  it("refuses formats it can't read", () => {
    const bytes = wav([1, 2]);
    new DataView(bytes.buffer).setUint16(34, 8, true); // 8-bit
    expect(() => parseWav(bytes)).toThrow(/16-bit/);
  });
});

describe("joinSamples", () => {
  it("joins clips end to end", () => {
    expect([...joinSamples([new Float32Array([1, 2]), new Float32Array([]), new Float32Array([3])])]).toEqual([1, 2, 3]);
  });
});
