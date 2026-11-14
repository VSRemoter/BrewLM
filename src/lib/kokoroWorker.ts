/// <reference lib="webworker" />
/**
 * The built-in voice's worker: Kokoro-82M through kokoro-js (ONNX Runtime in
 * WebAssembly), off the main thread so the app stays responsive while a long
 * Audio Overview is spoken. builtinKokoro.ts is its only caller.
 *
 * The ONNX Runtime's WebAssembly ships with the app (Vite bundles it next to
 * onnxruntime-web); the model (cached by transformers.js) and the voices
 * (cached by kokoro-js) are kept in the webview's Cache Storage after one
 * download from Hugging Face, so speaking works offline.
 */
import type { KokoroTTS } from "kokoro-js";
// The runtime's WebAssembly, by its file: onnxruntime-web's own lookup breaks once Vite's dev server
// moves the package, and transformers.js would fetch it from a CDN instead. Same version transformers.js uses.
import ortWasmUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url";
import { KOKORO_MODEL, KOKORO_VOICES, kokoroVoiceUrl, splitForKokoro } from "./kokoroShared";

type Request =
  | { id: number; type: "download" }
  | { id: number; type: "speak"; text: string; voice: string };

let tts: Promise<KokoroTTS> | null = null;

async function load(progress?: (file: string, loaded: number, total: number) => void): Promise<KokoroTTS> {
  const [{ KokoroTTS }, { env }] = await Promise.all([import("kokoro-js"), import("@huggingface/transformers")]);
  env.allowLocalModels = false;
  const wasm = env.backends.onnx.wasm!;
  // The copy that ships with the app (works offline), not transformers.js's CDN default.
  wasm.wasmPaths = { wasm: new URL(ortWasmUrl, self.location.href).href };
  // No cross-origin isolation in the app, so no shared memory: one thread.
  wasm.numThreads = 1;
  return KokoroTTS.from_pretrained(KOKORO_MODEL, {
    dtype: "q8",
    device: "wasm",
    progress_callback: (p: { status?: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status === "progress" && p.file) progress?.(p.file, p.loaded ?? 0, p.total ?? 0);
    },
  });
}

function model(): Promise<KokoroTTS> {
  if (!tts) {
    tts = load();
    tts.catch(() => (tts = null));
  }
  return tts;
}

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

self.onmessage = async (e: MessageEvent<Request>) => {
  const req = e.data;
  try {
    if (req.type === "download") {
      const files = new Map<string, { loaded: number; total: number }>();
      const report = (file: string, loaded: number, total: number) => {
        files.set(file, { loaded, total });
        let l = 0;
        let t = 0;
        for (const f of files.values()) {
          l += f.loaded;
          t += Math.max(f.total, f.loaded);
        }
        post({ id: req.id, type: "progress", loaded: l, total: t });
      };
      tts = load(report);
      await tts;
      // The voices BrewLM offers, so speaking works offline too.
      const voices = await caches.open("kokoro-voices");
      for (const v of KOKORO_VOICES) {
        const url = kokoroVoiceUrl(v.id);
        if (await voices.match(url)) continue;
        const res = await fetch(url);
        if (res.ok) await voices.put(url, new Response(await res.arrayBuffer(), { headers: res.headers }));
      }
      post({ id: req.id, type: "done" });
      return;
    }
    const m = await model();
    // Kokoro reads about 500 tokens at a time: long lines go sentence by sentence.
    const pieces: Float32Array[] = [];
    let rate = 24000;
    for (const piece of splitForKokoro(req.text)) {
      const audio = await m.generate(piece, { voice: req.voice as never });
      pieces.push(audio.audio);
      rate = audio.sampling_rate;
    }
    const len = pieces.reduce((n, p) => n + p.length, 0);
    const samples = new Float32Array(len);
    let at = 0;
    for (const p of pieces) {
      samples.set(p, at);
      at += p.length;
    }
    post({ id: req.id, type: "audio", samples, rate }, [samples.buffer]);
  } catch (err) {
    post({ id: req.id, type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
