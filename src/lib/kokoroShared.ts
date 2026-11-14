/**
 * What the built-in voice's worker and the app share: where its files come
 * from and the voices offered. No imports, so the worker stays small.
 */

/** Kokoro-82M (Apache-2.0), 8-bit: about 90 MB. */
export const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
/** Cache Storage buckets the built-in voice fills; deleting them removes it. */
export const KOKORO_CACHES = ["transformers-cache", "kokoro-voices"];
/** The model file that proves the download finished (q8 = model_quantized.onnx). */
export const KOKORO_MODEL_FILE = `https://huggingface.co/${KOKORO_MODEL}/resolve/main/onnx/model_quantized.onnx`;
/** About what one download takes, for the button: the 8-bit model and the offered voices. */
export const KOKORO_DOWNLOAD_MB = 95;

/** The voices offered, best-rated first in each accent (Kokoro's own grades). */
export const KOKORO_VOICES: { id: string; name: string }[] = [
  { id: "af_heart", name: "Heart (US, female)" },
  { id: "af_bella", name: "Bella (US, female)" },
  { id: "af_nicole", name: "Nicole (US, female, soft)" },
  { id: "am_michael", name: "Michael (US, male)" },
  { id: "am_fenrir", name: "Fenrir (US, male)" },
  { id: "am_puck", name: "Puck (US, male)" },
  { id: "bf_emma", name: "Emma (UK, female)" },
  { id: "bf_isabella", name: "Isabella (UK, female)" },
  { id: "bm_george", name: "George (UK, male)" },
  { id: "bm_fable", name: "Fable (UK, male)" },
];

export function kokoroVoiceUrl(id: string): string {
  return `https://huggingface.co/${KOKORO_MODEL}/resolve/main/voices/${id}.bin`;
}

/**
 * Text in pieces Kokoro can read at once (it takes about 500 tokens): whole
 * sentences up to `max` characters, a long sentence split at commas or spaces.
 */
export function splitForKokoro(text: string, max = 350): string[] {
  const sentences = text.replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [];
  const out: string[] = [];
  let cur = "";
  const push = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  for (const s of sentences) {
    if (s.length > max) {
      push();
      let rest = s.trim();
      while (rest.length > max) {
        const cut = Math.max(rest.lastIndexOf(", ", max), rest.lastIndexOf(" ", max));
        const at = cut > max / 3 ? cut + 1 : max;
        out.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      cur = rest;
    } else if ((cur + s).length > max) {
      push();
      cur = s;
    } else cur += s;
  }
  push();
  return out;
}
