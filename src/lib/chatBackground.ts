/**
 * Chat backgrounds: a still picture, or a moving one (GIF or short video).
 *
 * Moving backgrounds are stored as a muted, looping H.264 MP4: the same clip
 * is often a tenth the size of the GIF, plays smoothly on the GPU, and a
 * <video> can be paused (reduced motion, hidden window, the Animate
 * backgrounds setting) where a GIF can't. A background syncs and always
 * rides along with share links, so it's held to BG_MAX_BYTES after
 * conversion; a longer clip keeps its first BG_MAX_SECONDS.
 *
 * Where this device can't encode video, a GIF that's already small enough is
 * kept as it is, and so is an MP4/WebM.
 */
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSource,
  canEncodeVideo,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
} from "mediabunny";
import { mediaExt, putBlob } from "./blobs";
import { gifFrames, isGif, parseGif, type ParsedGif } from "./gif";
import { fileToCoverDataUrl } from "./source";

const MB = 1024 * 1024;
/** A converted background's ceiling: it loads with the notebook and travels with every share link. */
export const BG_MAX_BYTES = 10 * MB;
/** Longer clips keep their first minute. */
export const BG_MAX_SECONDS = 60;
/** Files bigger than this are refused before they're read. */
export const BG_MAX_SOURCE_BYTES = 100 * MB;
/** Longest side of a moving background (still ones stay at 1600, see pickChatBg). */
const BG_MAX_SIDE = 1920;
const BG_MAX_FPS = 30;
/** A still background: longest side and JPEG quality. */
const STILL_SIDE = 1600;
const STILL_QUALITY = 0.8;

export const BG_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"];
export const BG_VIDEO_EXTENSIONS = ["mp4", "webm", "mov", "m4v"];
const VIDEO_EXT = new Set(["mp4", "webm", "mov", "m4v"]);

/** A problem worth showing the person as it is. */
export class BackgroundError extends Error {}

/** True when a stored background is a video loop (it plays in a <video>). */
export function isVideoBackground(v: string): boolean {
  return !!v && VIDEO_EXT.has(mediaExt(v));
}

/** True when a stored background is a GIF kept as-is (it can't be paused, only frozen). */
export function isGifBackground(v: string): boolean {
  return !!v && mediaExt(v) === "gif";
}

const sizeLabel = (bytes: number) => `${Math.max(1, Math.round(bytes / MB))} MB`;
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * A picked file → the value to save as the notebook's chat background: a
 * JPEG data URL for still pictures, or a stored file's reference.
 */
export async function prepareChatBackground(name: string, bytes: Uint8Array, size = bytes.length): Promise<string> {
  // `size` is the file's size on disk: a file over the limit arrives unread (empty bytes).
  if (size > BG_MAX_SOURCE_BYTES || bytes.length > BG_MAX_SOURCE_BYTES)
    throw new BackgroundError(`That file is ${sizeLabel(size)}. Backgrounds can be made from files up to ${sizeLabel(BG_MAX_SOURCE_BYTES)}.`);
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (VIDEO_EXT.has(ext)) return videoBackground(bytes, ext);
  if (isGif(bytes)) {
    let gif: ParsedGif | null = null;
    try {
      gif = parseGif(bytes);
    } catch {
      /* a damaged GIF may still decode as a picture */
    }
    if (gif && gif.frames.length > 1) return gifBackground(bytes, gif);
  }
  return stillBackground(bytes);
}

async function stillBackground(bytes: Uint8Array): Promise<string> {
  const file = new File([bytes as BlobPart], "background", { type: "image/*" });
  try {
    return await fileToCoverDataUrl(file, STILL_SIDE, STILL_QUALITY);
  } catch {
    throw new BackgroundError("Couldn't read that image file.");
  }
}

/** Output size: within BG_MAX_SIDE, even sides (H.264 needs them). */
function fitSize(w: number, h: number): { width: number; height: number } {
  const scale = Math.min(1, BG_MAX_SIDE / Math.max(w, h));
  return { width: even(w * scale), height: even(h * scale) };
}

/**
 * Bits per second: enough for a sharp picture at this size, but never more
 * than fits BG_MAX_BYTES over the clip's length (with room for the encoder
 * overshooting its target).
 */
export function backgroundBitrate(width: number, height: number, fps: number, seconds: number): number {
  const wanted = Math.min(4_000_000, Math.max(400_000, width * height * Math.max(1, fps) * 0.07));
  const fits = (BG_MAX_BYTES * 8 * 0.8) / Math.max(1, seconds);
  return Math.round(Math.min(wanted, fits));
}

export interface PlannedFrame {
  /** GIF frame index. */
  index: number;
  /** Seconds. */
  timestamp: number;
  duration: number;
}

/**
 * Which GIF frames become video frames, and when: at most BG_MAX_FPS (a
 * frame shown for less than that is skipped, the one before it shows longer)
 * and nothing past BG_MAX_SECONDS.
 */
export function planGifFrames(delaysMs: number[], maxFps = BG_MAX_FPS, maxSeconds = BG_MAX_SECONDS): PlannedFrame[] {
  // Whole milliseconds until the end, so timestamps don't drift.
  const gap = 1000 / maxFps - 1e-6;
  const starts: { index: number; ms: number }[] = [];
  let start = 0;
  let total = 0;
  for (const d of delaysMs) total += d;
  const end = Math.min(total, maxSeconds * 1000);
  for (let i = 0; i < delaysMs.length && start < end; i++) {
    const last = starts[starts.length - 1];
    if (!last || start - last.ms >= gap) starts.push({ index: i, ms: start });
    start += delaysMs[i];
  }
  return starts.map((s, i) => ({
    index: s.index,
    timestamp: s.ms / 1000,
    duration: ((i + 1 < starts.length ? starts[i + 1].ms : end) - s.ms) / 1000,
  }));
}

async function gifBackground(bytes: Uint8Array, gif: ParsedGif): Promise<string> {
  const plan = planGifFrames(gif.frames.map((f) => f.delayMs));
  const seconds = plan.length ? plan[plan.length - 1].timestamp + plan[plan.length - 1].duration : 0;
  const { width, height } = fitSize(gif.width, gif.height);
  const fps = Math.min(BG_MAX_FPS, plan.length / Math.max(0.1, seconds));
  const bitrate = backgroundBitrate(width, height, fps, seconds);
  const canEncode = await canEncodeVideo("avc", { width, height, bitrate, frameRate: fps }).catch(() => false);
  if (!canEncode) {
    if (bytes.length <= BG_MAX_BYTES) return putBlob(bytes, "gif");
    throw new BackgroundError(
      `This GIF is ${sizeLabel(bytes.length)} and this device can't convert it to a smaller video. Try one under ${sizeLabel(BG_MAX_BYTES)}.`
    );
  }
  for (const share of [1, 0.6]) {
    const mp4 = await encodeGif(bytes, gif, plan, width, height, Math.round(bitrate * share));
    if (mp4.length <= BG_MAX_BYTES) return putBlob(mp4, "mp4");
  }
  throw new BackgroundError(`This GIF is still over ${sizeLabel(BG_MAX_BYTES)} as a video. Try a shorter or smaller one.`);
}

/** Let the page repaint (a "Converting…" label) between stretches of decoding. */
const breathe = () => new Promise<void>((r) => setTimeout(r, 0));

async function encodeGif(
  bytes: Uint8Array,
  gif: ParsedGif,
  plan: PlannedFrame[],
  width: number,
  height: number,
  bitrate: number
): Promise<Uint8Array> {
  const full = document.createElement("canvas");
  full.width = gif.width;
  full.height = gif.height;
  const fullCtx = full.getContext("2d");
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const outCtx = out.getContext("2d");
  if (!fullCtx || !outCtx) throw new BackgroundError("Canvas is unavailable.");
  outCtx.imageSmoothingQuality = "high";
  const picture = new ImageData(gif.width, gif.height);

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
  const source = new CanvasSource(out, { codec: "avc", quality: new Quality({ bitrate }), keyFrameInterval: 2 });
  output.addVideoTrack(source);
  await output.start();
  const slot = new Map(plan.map((p) => [p.index, p]));
  const lastIndex = plan.length ? plan[plan.length - 1].index : -1;
  try {
    for (const frame of gifFrames(bytes, gif)) {
      const p = slot.get(frame.index);
      if (p) {
        picture.data.set(frame.rgba);
        fullCtx.putImageData(picture, 0, 0);
        // Transparent areas become black, as still backgrounds' do.
        outCtx.fillStyle = "#000";
        outCtx.fillRect(0, 0, width, height);
        outCtx.drawImage(full, 0, 0, width, height);
        await source.add(p.timestamp, p.duration);
      } else if (frame.index % 8 === 0) await breathe();
      if (frame.index >= lastIndex) break;
    }
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => {});
    throw e;
  }
  const buf = (output.target as BufferTarget).buffer;
  if (!buf) throw new BackgroundError("Couldn't convert that GIF.");
  return new Uint8Array(buf);
}

async function videoBackground(bytes: Uint8Array, ext: string): Promise<string> {
  const keepAsIs = async () => {
    if (bytes.length <= BG_MAX_BYTES && (ext === "mp4" || ext === "webm" || ext === "m4v"))
      return putBlob(bytes, ext === "m4v" ? "mp4" : ext);
    throw new BackgroundError(`Couldn't convert that video on this device. Try an MP4 under ${sizeLabel(BG_MAX_BYTES)}.`);
  };
  const input = new Input({ source: new BlobSource(new Blob([bytes as BlobPart])), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new BackgroundError("That file has no video in it.");
    const [w0, h0, codec, seconds] = await Promise.all([
      track.getDisplayWidth(),
      track.getDisplayHeight(),
      track.getCodec(),
      input.computeDuration(),
    ]);
    const length = Math.min(seconds, BG_MAX_SECONDS);
    const { width, height } = fitSize(w0, h0);
    // Already a small H.264 clip: copy the picture as it is and only drop the sound.
    const copy = codec === "avc" && bytes.length <= BG_MAX_BYTES && Math.max(w0, h0) <= BG_MAX_SIDE && seconds <= BG_MAX_SECONDS;
    const bitrate = backgroundBitrate(width, height, BG_MAX_FPS, length);
    for (const share of copy ? [0] : [1, 0.6]) {
      const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
      const conversion = await Conversion.init({
        input,
        output,
        tracks: "primary",
        audio: { discard: true },
        video: share
          ? {
              codec: "avc",
              width,
              height,
              fit: "cover" as const,
              quality: new Quality({ bitrate: Math.round(bitrate * share) }),
            }
          : {},
        trim: seconds > BG_MAX_SECONDS ? { start: 0, end: BG_MAX_SECONDS } : undefined,
        showWarnings: false,
      });
      if (!conversion.isValid || conversion.utilizedTracks.length === 0) return keepAsIs();
      await conversion.execute();
      const buf = (output.target as BufferTarget).buffer;
      if (buf && buf.byteLength <= BG_MAX_BYTES) return putBlob(new Uint8Array(buf), "mp4");
    }
    throw new BackgroundError(`That video is still over ${sizeLabel(BG_MAX_BYTES)} after converting. Try a shorter one.`);
  } catch (e) {
    if (e instanceof BackgroundError) throw e;
    console.warn("chat background: video conversion failed", e);
    return keepAsIs();
  } finally {
    input.dispose();
  }
}
