/**
 * The built-in voice for local Audio Overviews: Kokoro-82M running inside
 * BrewLM, so speaking needs no speech server and nothing leaves the computer.
 * Downloaded on request (Settings → Audio Voices); the work happens in
 * kokoroWorker.ts.
 */
import { KOKORO_CACHES, KOKORO_MODEL_FILE } from "./kokoroShared";

export { KOKORO_DOWNLOAD_MB, KOKORO_VOICES } from "./kokoroShared";

type Reply =
  | { id: number; type: "progress"; loaded: number; total: number }
  | { id: number; type: "done" }
  | { id: number; type: "audio"; samples: Float32Array; rate: number }
  | { id: number; type: "error"; message: string };

/** A voice worker and how many lines it's working on. */
interface Lane {
  worker: Worker;
  busy: number;
}
/** Up to kokoroLanes() workers; lines go to the least busy one. */
const lanes: (Lane | null)[] = [];
let nextId = 1;
const waiting = new Map<number, { resolve: (r: Reply) => void; progress?: (loaded: number, total: number) => void; lane: number }>();

/**
 * How many lines are spoken at once. Each worker runs one thread and holds
 * its own copy of the model (a few hundred MB), so: one per four cores, at
 * most three. (Measured on a 10-core Mac: two workers 1.07× real time,
 * three 0.89× — they compete for the performance cores — one 0.66×.)
 */
export function kokoroLanes(): number {
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
  return Math.max(1, Math.min(3, Math.floor(cores / 4)));
}

function lane(i: number): Lane {
  let l = lanes[i];
  if (!l) {
    const worker = new Worker(new URL("./kokoroWorker.ts", import.meta.url), { type: "module" });
    l = { worker, busy: 0 };
    lanes[i] = l;
    worker.onmessage = (e: MessageEvent<Reply>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      if (e.data.type === "progress") return w.progress?.(e.data.loaded, e.data.total);
      waiting.delete(e.data.id);
      w.resolve(e.data);
    };
    worker.onerror = (e) => {
      for (const [id, w] of waiting)
        if (w.lane === i) {
          waiting.delete(id);
          w.resolve({ id, type: "error", message: e.message || "The built-in voice stopped." });
        }
      worker.terminate();
      lanes[i] = null;
    };
  }
  return l;
}

/** The least busy worker; one not started yet counts as idle, so new ones start only when the rest are busy. */
function freeLane(): number {
  let best = 0;
  for (let i = 1; i < kokoroLanes(); i++) if ((lanes[i]?.busy ?? 0) < (lanes[best]?.busy ?? 0)) best = i;
  return best;
}

function ask(
  msg: Record<string, unknown>,
  opts: { progress?: (loaded: number, total: number) => void; signal?: AbortSignal; lane?: number } = {}
): Promise<Reply> {
  const id = nextId++;
  const i = opts.lane ?? freeLane();
  const l = lane(i);
  l.busy++;
  return new Promise<Reply>((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    waiting.set(id, { resolve, progress: opts.progress, lane: i });
    // A cancel can't stop the model mid-line; the line finishes and is dropped.
    opts.signal?.addEventListener(
      "abort",
      () => {
        waiting.delete(id);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
    l.worker.postMessage({ id, ...msg });
  }).finally(() => {
    l.busy--;
  });
}

/** Whether the voice is downloaded: its model is in the cache. */
export async function kokoroReady(): Promise<boolean> {
  try {
    return !!(await (await caches.open("transformers-cache")).match(KOKORO_MODEL_FILE));
  } catch {
    return false;
  }
}

/** Download the voice (model and voices), reporting bytes as they arrive. */
export async function downloadKokoro(onProgress: (loaded: number, total: number) => void): Promise<void> {
  const r = await ask({ type: "download" }, { progress: onProgress, lane: 0 });
  if (r.type === "error") throw new Error(`Couldn't download the built-in voice: ${r.message}`);
}

/** Remove the voice from this computer. */
export async function deleteKokoro(): Promise<void> {
  for (let i = 0; i < lanes.length; i++) {
    lanes[i]?.worker.terminate();
    lanes[i] = null;
  }
  await Promise.all(KOKORO_CACHES.map((name) => caches.delete(name).catch(() => false)));
}

/** One line in a voice: samples and their rate (24 kHz). */
export async function kokoroSpeak(text: string, voice: string, signal?: AbortSignal): Promise<{ samples: Float32Array; rate: number }> {
  const r = await ask({ type: "speak", text, voice }, { signal });
  if (r.type === "error") throw new Error(`The built-in voice couldn't speak: ${r.message}`);
  if (r.type !== "audio") throw new Error("The built-in voice sent no audio.");
  return { samples: r.samples, rate: r.rate };
}
