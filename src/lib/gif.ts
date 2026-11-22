/**
 * A small GIF decoder for animated chat backgrounds (chatBackground.ts turns
 * the frames into an MP4 loop).
 *
 * The desktop app runs in WebKit, which has no ImageDecoder, so a browser
 * <img> is the only built-in way to read a GIF, and it can't hand frames
 * over one by one. This reads the file itself: `parseGif` walks the blocks
 * once (cheap: no pixel decoding) to learn the size, frame count and timing;
 * `frames()` then decodes and composites one frame at a time into a single
 * reused RGBA buffer, so a long 1080p GIF never sits in memory as hundreds
 * of full frames.
 *
 * Compositing follows browsers: disposal 2 clears the frame's area to
 * transparent (not the background color), disposal 3 restores what was there
 * before, and delays under 20 ms play as 100 ms.
 */

export interface GifFrameInfo {
  left: number;
  top: number;
  width: number;
  height: number;
  /** How long the frame shows, in ms (already adjusted like browsers do). */
  delayMs: number;
  /** 0/1 keep, 2 clear to transparent, 3 restore the previous picture. */
  disposal: number;
  /** Palette index drawn as transparent, or -1. */
  transparentIndex: number;
  interlaced: boolean;
  /** RGB triplets (the frame's own palette, else the global one). */
  palette: Uint8Array | null;
  minCodeSize: number;
  /** Offset of the frame's first image data sub-block. */
  dataStart: number;
}

export interface ParsedGif {
  width: number;
  height: number;
  frames: GifFrameInfo[];
  /** Sum of the frames' delays, in ms. */
  durationMs: number;
}

export interface GifFrame {
  index: number;
  /**
   * The whole picture after this frame, width × height × 4. The same buffer is
   * reused for every frame: use it before asking for the next one.
   */
  rgba: Uint8ClampedArray;
}

/** Below this, browsers ignore the delay and wait 100 ms (many GIFs say 0). */
const MIN_DELAY_MS = 20;
const DEFAULT_DELAY_MS = 100;

export function isGif(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 13 &&
    bytes[0] === 0x47 && // G
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x38 && // 8
    (bytes[4] === 0x37 || bytes[4] === 0x39) && // 7 | 9
    bytes[5] === 0x61 // a
  );
}

/**
 * Read a GIF's layout and timing. Throws on a file that isn't a GIF; a GIF cut
 * short keeps the frames that arrived whole.
 */
export function parseGif(bytes: Uint8Array): ParsedGif {
  if (!isGif(bytes)) throw new Error("not a GIF file");
  const u16 = (at: number) => bytes[at] | (bytes[at + 1] << 8);
  const width = u16(6);
  const height = u16(8);
  if (!width || !height) throw new Error("this GIF has no size");
  const screen = bytes[10];
  let pos = 13;
  let globalPalette: Uint8Array | null = null;
  if (screen & 0x80) {
    const len = 3 * (1 << ((screen & 7) + 1));
    globalPalette = bytes.subarray(pos, pos + len);
    pos += len;
  }

  /** Past a run of sub-blocks; -1 when the file ends inside it. */
  const skipSubBlocks = (at: number): number => {
    while (at < bytes.length) {
      const size = bytes[at];
      if (size === 0) return at + 1;
      at += size + 1;
    }
    return -1;
  };

  const frames: GifFrameInfo[] = [];
  let durationMs = 0;
  // Graphic control for the next image.
  let delayMs = DEFAULT_DELAY_MS;
  let disposal = 0;
  let transparentIndex = -1;

  while (pos < bytes.length) {
    const block = bytes[pos];
    if (block === 0x3b) break; // trailer
    if (block === 0x21) {
      const label = bytes[pos + 1];
      if (label === 0xf9 && bytes[pos + 2] >= 4 && pos + 6 < bytes.length) {
        const packed = bytes[pos + 3];
        disposal = (packed >> 2) & 7;
        const cs = u16(pos + 4) * 10;
        delayMs = cs < MIN_DELAY_MS ? DEFAULT_DELAY_MS : cs;
        transparentIndex = packed & 1 ? bytes[pos + 6] : -1;
      }
      const next = skipSubBlocks(pos + 2);
      if (next < 0) break;
      pos = next;
      continue;
    }
    if (block !== 0x2c || pos + 10 > bytes.length) break; // unknown block: stop with what we have
    const left = u16(pos + 1);
    const top = u16(pos + 3);
    const w = u16(pos + 5);
    const h = u16(pos + 7);
    const packed = bytes[pos + 9];
    pos += 10;
    let palette = globalPalette;
    if (packed & 0x80) {
      const len = 3 * (1 << ((packed & 7) + 1));
      palette = bytes.subarray(pos, pos + len);
      pos += len;
    }
    const minCodeSize = bytes[pos];
    const dataStart = pos + 1;
    const end = skipSubBlocks(dataStart);
    if (end < 0 || minCodeSize < 1 || minCodeSize > 11) break;
    pos = end;
    frames.push({
      left,
      top,
      width: w,
      height: h,
      delayMs,
      disposal,
      transparentIndex,
      interlaced: !!(packed & 0x40),
      palette,
      minCodeSize,
      dataStart,
    });
    durationMs += delayMs;
    delayMs = DEFAULT_DELAY_MS;
    disposal = 0;
    transparentIndex = -1;
  }
  if (frames.length === 0) throw new Error("this GIF has no frames");
  return { width, height, frames, durationMs };
}

/** One frame's image data sub-blocks joined into one run of bytes. */
function joinSubBlocks(bytes: Uint8Array, at: number): Uint8Array {
  let total = 0;
  for (let p = at; p < bytes.length && bytes[p] !== 0; p += bytes[p] + 1) total += bytes[p];
  const out = new Uint8Array(total);
  let o = 0;
  for (let p = at; p < bytes.length && bytes[p] !== 0; p += bytes[p] + 1) {
    const chunk = bytes.subarray(p + 1, Math.min(bytes.length, p + 1 + bytes[p]));
    out.set(chunk, o);
    o += chunk.length;
  }
  return out;
}

/**
 * GIF's LZW: palette indices for `count` pixels. Damaged data stops early and
 * leaves the rest at index 0, as browsers show a partial frame.
 */
export function lzwDecode(minCodeSize: number, data: Uint8Array, count: number): Uint8Array {
  const out = new Uint8Array(count);
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  for (let i = 0; i < clear; i++) suffix[i] = i;
  let codeSize = minCodeSize + 1;
  let codeMask = (1 << codeSize) - 1;
  let next = eoi + 1;
  let old = -1;
  let first = 0;
  let op = 0;
  let datum = 0;
  let bits = 0;
  let pos = 0;
  while (op < count) {
    while (bits < codeSize) {
      if (pos >= data.length) return out;
      datum |= data[pos++] << bits;
      bits += 8;
    }
    let code = datum & codeMask;
    datum >>>= codeSize;
    bits -= codeSize;
    if (code === clear) {
      codeSize = minCodeSize + 1;
      codeMask = (1 << codeSize) - 1;
      next = eoi + 1;
      old = -1;
      continue;
    }
    if (code === eoi) break;
    if (old === -1) {
      if (code >= clear) break;
      out[op++] = code;
      old = first = code;
      continue;
    }
    const current = code;
    let sp = 0;
    if (code >= next) {
      if (code > next) break; // can't happen in a valid stream
      stack[sp++] = first; // KwKwK: the previous string plus its own first byte
      code = old;
    }
    while (code > eoi) {
      stack[sp++] = suffix[code];
      code = prefix[code];
    }
    first = suffix[code];
    stack[sp++] = first;
    if (next < 4096) {
      prefix[next] = old;
      suffix[next] = first;
      next++;
      if ((next & codeMask) === 0 && next < 4096) {
        codeSize++;
        codeMask = (1 << codeSize) - 1;
      }
    }
    old = current;
    while (sp > 0 && op < count) out[op++] = stack[--sp];
  }
  return out;
}

/** Row order of an interlaced frame: every 8th from 0, every 8th from 4, every 4th from 2, every 2nd from 1. */
function interlacedRows(height: number): number[] {
  const rows: number[] = [];
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]])
    for (let y = start; y < height; y += step) rows.push(y);
  return rows;
}

/** Decode the frames in order, compositing each onto the picture so far. */
export function* gifFrames(bytes: Uint8Array, gif: ParsedGif): Generator<GifFrame> {
  const { width: W, height: H } = gif;
  const canvas = new Uint8ClampedArray(W * H * 4);
  let saved: Uint8ClampedArray | null = null;
  let prev: GifFrameInfo | null = null;
  for (let index = 0; index < gif.frames.length; index++) {
    const f = gif.frames[index];
    // The previous frame's disposal happens just before this one draws.
    if (prev?.disposal === 2) clearRect(canvas, W, H, prev);
    else if (prev?.disposal === 3 && saved) canvas.set(saved);
    if (f.disposal === 3) saved = canvas.slice();

    const pixels = lzwDecode(f.minCodeSize, joinSubBlocks(bytes, f.dataStart), f.width * f.height);
    const rows = f.interlaced ? interlacedRows(f.height) : null;
    const pal = f.palette;
    const colors = pal ? pal.length / 3 : 0;
    for (let r = 0; r < f.height; r++) {
      const y = f.top + (rows ? rows[r] : r);
      if (y >= H) continue;
      const src = r * f.width;
      for (let c = 0; c < f.width; c++) {
        const x = f.left + c;
        if (x >= W) break;
        const i = pixels[src + c];
        if (i === f.transparentIndex) continue;
        const o = (y * W + x) * 4;
        if (pal && i < colors) {
          canvas[o] = pal[i * 3];
          canvas[o + 1] = pal[i * 3 + 1];
          canvas[o + 2] = pal[i * 3 + 2];
        } else {
          canvas[o] = canvas[o + 1] = canvas[o + 2] = 0;
        }
        canvas[o + 3] = 255;
      }
    }
    yield { index, rgba: canvas };
    prev = f;
  }
}

function clearRect(canvas: Uint8ClampedArray, W: number, H: number, f: GifFrameInfo): void {
  const x1 = Math.min(W, f.left + f.width);
  const y1 = Math.min(H, f.top + f.height);
  for (let y = f.top; y < y1; y++) canvas.fill(0, (y * W + f.left) * 4, (y * W + x1) * 4);
}
