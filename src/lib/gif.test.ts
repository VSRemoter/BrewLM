import { describe, expect, it, vi } from "vitest";

vi.mock("../platform", () => ({ platform: {} }));
import { gifFrames, isGif, lzwDecode, parseGif } from "./gif";
import { backgroundBitrate, BG_MAX_BYTES, planGifFrames } from "./chatBackground";

/* ------------------------ a tiny GIF writer for tests ------------------------ */

interface TestFrame {
  left?: number;
  top?: number;
  w: number;
  h: number;
  /** Palette index per pixel, row by row. */
  px: number[];
  delayCs?: number;
  disposal?: number;
  transparent?: number;
  interlace?: boolean;
}

/**
 * LZW without compression: a clear code before every run of (clear − 2)
 * literals keeps the dictionary from ever growing a bit, so every code is
 * minCodeSize + 1 bits wide. Any decoder must read this.
 */
function lzwLiterals(minCodeSize: number, px: number[]): number[] {
  const clear = 1 << minCodeSize;
  const width = minCodeSize + 1;
  const codes: number[] = [];
  for (let i = 0; i < px.length; i += clear - 2) codes.push(clear, ...px.slice(i, i + clear - 2));
  codes.push(clear + 1);
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const c of codes) {
    acc |= c << bits;
    bits += width;
    while (bits >= 8) {
      out.push(acc & 0xff);
      acc >>>= 8;
      bits -= 8;
    }
  }
  if (bits > 0) out.push(acc & 0xff);
  return out;
}

const u16 = (n: number) => [n & 0xff, n >> 8];

function writeGif(width: number, height: number, palette: number[][], frames: TestFrame[]): Uint8Array {
  const out: number[] = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...u16(width), ...u16(height)];
  const bitsPer = Math.max(2, Math.ceil(Math.log2(palette.length)));
  out.push(0x80 | (bitsPer - 1), 0, 0);
  for (let i = 0; i < 1 << bitsPer; i++) out.push(...(palette[i] ?? [0, 0, 0]));
  for (const f of frames) {
    const t = f.transparent ?? -1;
    out.push(0x21, 0xf9, 4, ((f.disposal ?? 0) << 2) | (t >= 0 ? 1 : 0), ...u16(f.delayCs ?? 10), Math.max(0, t), 0);
    out.push(0x2c, ...u16(f.left ?? 0), ...u16(f.top ?? 0), ...u16(f.w), ...u16(f.h), f.interlace ? 0x40 : 0);
    let px = f.px;
    if (f.interlace) {
      const rows: number[] = [];
      for (const [s, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = s; y < f.h; y += step) rows.push(y);
      px = rows.flatMap((y) => f.px.slice(y * f.w, (y + 1) * f.w));
    }
    out.push(bitsPer);
    const data = lzwLiterals(bitsPer, px);
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.slice(i, i + 255);
      out.push(chunk.length, ...chunk);
    }
    out.push(0);
  }
  out.push(0x3b);
  return new Uint8Array(out);
}

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const WHITE = [255, 255, 255];
const PALETTE = [RED, GREEN, BLUE, WHITE];

/** Every frame's picture as [r,g,b,a] per pixel. */
function pictures(bytes: Uint8Array): number[][][] {
  const gif = parseGif(bytes);
  const out: number[][][] = [];
  for (const f of gifFrames(bytes, gif)) {
    const px: number[][] = [];
    for (let i = 0; i < f.rgba.length; i += 4) px.push([...f.rgba.slice(i, i + 4)]);
    out.push(px);
  }
  return out;
}
const rgba = (c: number[]) => [...c, 255];
const CLEAR = [0, 0, 0, 0];

/* ---------------------------------- tests ---------------------------------- */

describe("parseGif", () => {
  it("reads size, frames and timing without decoding pixels", () => {
    const g = writeGif(2, 1, PALETTE, [
      { w: 2, h: 1, px: [0, 1], delayCs: 5 },
      { w: 2, h: 1, px: [1, 0], delayCs: 0 },
      { w: 2, h: 1, px: [1, 1], delayCs: 1 },
    ]);
    expect(isGif(g)).toBe(true);
    const gif = parseGif(g);
    expect([gif.width, gif.height, gif.frames.length]).toEqual([2, 1, 3]);
    // 0 and 1 centisecond play as 100 ms, like browsers.
    expect(gif.frames.map((f) => f.delayMs)).toEqual([50, 100, 100]);
    expect(gif.durationMs).toBe(250);
  });

  it("rejects files that aren't GIFs and keeps whole frames of a cut-off one", () => {
    expect(() => parseGif(new Uint8Array([1, 2, 3]))).toThrow();
    const g = writeGif(2, 1, PALETTE, [
      { w: 2, h: 1, px: [0, 1] },
      { w: 2, h: 1, px: [1, 0] },
    ]);
    expect(parseGif(g.subarray(0, g.length - 6)).frames.length).toBe(1);
  });
});

describe("gifFrames", () => {
  it("decodes palette colors", () => {
    const g = writeGif(4, 1, PALETTE, [{ w: 4, h: 1, px: [0, 1, 2, 3] }]);
    expect(pictures(g)[0]).toEqual([RED, GREEN, BLUE, WHITE].map(rgba));
  });

  it("decodes frames longer than one clear run", () => {
    const px = Array.from({ length: 64 }, (_, i) => i % 4);
    const g = writeGif(8, 8, PALETTE, [{ w: 8, h: 8, px }]);
    expect(pictures(g)[0]).toEqual(px.map((i) => rgba(PALETTE[i])));
  });

  it("puts interlaced rows back in order", () => {
    const px = Array.from({ length: 10 }, (_, y) => y % 4); // one column, 10 rows
    const g = writeGif(1, 10, PALETTE, [{ w: 1, h: 10, px, interlace: true }]);
    expect(pictures(g)[0]).toEqual(px.map((i) => rgba(PALETTE[i])));
  });

  it("draws sub-rectangles over the previous picture, skipping transparent pixels", () => {
    const g = writeGif(3, 1, PALETTE, [
      { w: 3, h: 1, px: [0, 0, 0] },
      { left: 1, w: 2, h: 1, px: [3, 2], transparent: 3 },
    ]);
    const [a, b] = pictures(g);
    expect(a).toEqual([RED, RED, RED].map(rgba));
    expect(b).toEqual([rgba(RED), rgba(RED), rgba(BLUE)]);
  });

  it("disposal 2 clears the frame's area to transparent before the next frame", () => {
    const g = writeGif(2, 1, PALETTE, [
      { w: 2, h: 1, px: [0, 0] },
      { left: 1, w: 1, h: 1, px: [1], disposal: 2 },
      { w: 1, h: 1, px: [2] },
    ]);
    const [, b, c] = pictures(g);
    expect(b).toEqual([rgba(RED), rgba(GREEN)]);
    expect(c).toEqual([rgba(BLUE), CLEAR]);
  });

  it("disposal 3 restores the picture from before the frame", () => {
    const g = writeGif(2, 1, PALETTE, [
      { w: 2, h: 1, px: [0, 0] },
      { w: 2, h: 1, px: [1, 1], disposal: 3 },
      { left: 1, w: 1, h: 1, px: [2] },
    ]);
    const [, b, c] = pictures(g);
    expect(b).toEqual([rgba(GREEN), rgba(GREEN)]);
    expect(c).toEqual([rgba(RED), rgba(BLUE)]);
  });

  it("clips frames that reach past the picture", () => {
    const g = writeGif(2, 1, PALETTE, [{ left: 1, w: 2, h: 2, px: [1, 2, 3, 3] }]);
    expect(pictures(g)[0]).toEqual([CLEAR, rgba(GREEN)]);
  });
});

describe("lzwDecode", () => {
  it("handles codes that refer to the entry being made (KwKwK)", () => {
    // minCodeSize 2: clear=4, eoi=5. Codes 4, 1, 6, 5 → "1", then 6 = "1"+"1".
    // 3-bit codes packed LSB first: 100 001 110 101.
    const bits = [4, 1, 6, 5].reduce((acc, c, i) => acc | (c << (i * 3)), 0);
    const data = new Uint8Array([bits & 0xff, (bits >> 8) & 0xff]);
    expect([...lzwDecode(2, data, 3)]).toEqual([1, 1, 1]);
  });

  it("stops on damaged data and leaves the rest at index 0", () => {
    expect([...lzwDecode(2, new Uint8Array([0x0c]), 4)]).toEqual([1, 0, 0, 0]);
  });
});

describe("planGifFrames", () => {
  it("keeps every frame at or under 30 fps", () => {
    expect(planGifFrames([100, 100, 50])).toEqual([
      { index: 0, timestamp: 0, duration: 0.1 },
      { index: 1, timestamp: 0.1, duration: 0.1 },
      { index: 2, timestamp: 0.2, duration: 0.05 },
    ]);
  });

  it("skips frames shown for less than a 30 fps step; the one before shows longer", () => {
    const plan = planGifFrames([10, 10, 10, 10, 10, 10]);
    expect(plan.map((p) => p.index)).toEqual([0, 4]);
    expect(plan[0].duration).toBeCloseTo(0.04);
    expect(plan[1].duration).toBeCloseTo(0.02);
  });

  it("stops at the time limit", () => {
    const plan = planGifFrames([400, 400, 400], 30, 1);
    expect(plan.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(plan[2].duration).toBeCloseTo(0.2);
    expect(planGifFrames([2000, 400], 30, 1).map((p) => [p.index, p.duration])).toEqual([[0, 1]]);
  });
});

describe("backgroundBitrate", () => {
  it("scales with the picture and stays within the size limit", () => {
    expect(backgroundBitrate(480, 270, 10, 5)).toBe(400_000); // floor for small GIFs
    expect(backgroundBitrate(1920, 1080, 30, 5)).toBe(4_000_000); // ceiling
    const long = backgroundBitrate(1920, 1080, 30, 60);
    expect((long * 60) / 8).toBeLessThan(BG_MAX_BYTES);
  });
});
