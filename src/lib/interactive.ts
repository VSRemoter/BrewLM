/**
 * Interactive Studio outputs: an AI-written, self-contained HTML page — a
 * guided animation, an explorable simulation or a small learning game — that
 * makes a process in the sources visible.
 *
 * Generation is two passes: a storyboard grounded in the sources (facts,
 * scenes, controls), then the page built from that storyboard alone, so the
 * expensive long-output pass doesn't re-read every source. The page runs in a
 * sandboxed iframe (scripts only, opaque origin, no network) — see sandboxDoc.
 */
import { streamChat, type LlmMessage, type StreamUsage } from "./llm";
import type { Provider, Thinking } from "./types";

export type InteractiveStyle = "animation" | "simulation" | "game";

export const INTERACTIVE_STYLES: InteractiveStyle[] = ["animation", "simulation", "game"];

export const INTERACTIVE_STYLE_LABELS: Record<InteractiveStyle, string> = {
  animation: "Animation",
  simulation: "Simulation",
  game: "Game",
};

export const INTERACTIVE_STYLE_DESCS: Record<InteractiveStyle, string> = {
  animation: "A guided, step-by-step animation with captions — play, pause and step through it.",
  simulation: "A live model with sliders and toggles — change the inputs and watch what happens.",
  game: "Short hands-on challenges with instant feedback and a score.",
};

export interface InteractiveOptions {
  style: InteractiveStyle;
  /** What to visualize; empty = the model picks the most visual process in the sources. */
  topic: string;
  sourceIds: string[];
  /** Custom name for the saved artifact (falls back to the tool default). */
  title?: string;
}

/** What an "interactive" artifact stores (JSON in artifact.data). */
export interface InteractiveData {
  html: string;
  /** The markdown plan the page was built from — the readable text of the output. */
  storyboard: string;
  style: InteractiveStyle;
}

export function parseInteractive(data: string): InteractiveData | null {
  try {
    const d = JSON.parse(data);
    if (typeof d?.html !== "string" || !d.html.trim()) return null;
    return {
      html: d.html,
      storyboard: typeof d.storyboard === "string" ? d.storyboard : "",
      style: INTERACTIVE_STYLES.includes(d.style) ? d.style : "animation",
    };
  } catch {
    return null;
  }
}

/* --------------------------------- prompts --------------------------------- */

const STYLE_BRIEF: Record<InteractiveStyle, string> = {
  animation:
    "a guided animation: a sequence of scenes the learner plays, pauses and steps through, each one animating what changes and showing a short caption",
  simulation:
    "an explorable simulation: a live model whose key parameters the learner changes with sliders and toggles, with visuals and numeric readouts updating in real time",
  game:
    "a short learning game: a handful of hands-on challenges (drag, click, order, predict what happens next) with instant feedback, a score and a recap at the end",
};

export function buildStoryboardPrompt(opts: Pick<InteractiveOptions, "style" | "topic">): string {
  const topic = opts.topic.trim()
    ? `Topic: ${opts.topic.trim()}`
    : "Topic: pick the single process or mechanism in my sources that benefits most from being seen in motion.";
  return `I want to turn part of my sources into ${STYLE_BRIEF[opts.style]}, built as an interactive web page.

${topic}

Write the storyboard for it in markdown — not the code. Include:
1. **Title** and a one-sentence learning goal.
2. **Visual layout** — what is on screen (objects, labels, axes, colors and what each color means).
3. **${opts.style === "game" ? "Challenges" : "Scenes"}** — ${opts.style === "game" ? "4–6 challenges, each with the task, the correct answer and the feedback for right and wrong answers" : "4–8 in order, each with what is shown, what moves or changes, and a 1–2 sentence caption"}.
4. **Key facts and values** — every number, unit, threshold and named structure the page must show, exactly as my sources give them.
5. **Controls** — ${opts.style === "simulation" ? "each slider/toggle with its range, default and what it changes" : "the controls the learner uses"}.
6. **Takeaways** — 3 short points the learner should leave with.

Use the facts in my sources. Where the visual needs a detail my sources don't give (e.g. a standard value), use the standard textbook value and mark it "(general knowledge)". Keep it under 900 words.`;
}

/** Instructions for the build pass; the storyboard goes in the user message. */
export function buildPageSystem(style: InteractiveStyle): string {
  return `You build single-file interactive web pages that teach. You write ${STYLE_BRIEF[style]}, following the storyboard you are given exactly — its facts, values, labels and order.

Hard requirements:
- Output ONE complete HTML document and nothing else: start with <!DOCTYPE html>, end with </html>. No markdown fences, no commentary.
- Everything inline: CSS in <style>, JavaScript in <script>. No external resources of any kind — no CDNs, libraries, web fonts, images or network requests. They are blocked and the page breaks. Draw with SVG, Canvas and CSS; animate with requestAnimationFrame or CSS transitions. Use the system font stack.
- The page runs in a sandbox: do not use localStorage, sessionStorage, cookies, alert, confirm, prompt, window.open or forms.
- Fill the viewport and work from 320px wide up to a full desktop screen. No horizontal scrolling. Readable text (at least 13px), large click targets.
- Theming: define every color as a CSS variable on :root (light palette) and override them under :root[data-theme="dark"]. The host sets data-theme on <html>. Use a clear, restrained palette; color-code meaningfully and add a legend.
- ${style === "animation" ? "Controls: Play/Pause, Back, Next, Restart, a scene indicator (e.g. 3 / 6) and a speed control. Space toggles play, ←/→ step. Start paused on scene 1 with the caption visible." : style === "simulation" ? "Controls: labelled sliders/toggles with live values and units, a Reset button, and 2–3 \"Try this\" suggestions that set up interesting cases. Changes take effect immediately and smoothly." : "Flow: an intro screen with a Start button, one challenge at a time, immediate feedback explaining why, a visible score, and a final recap screen with Play again."}
- Label every structure and show values with units. Be scientifically accurate to the storyboard.
- Plain, robust JavaScript: wrap it in an IIFE, guard against null elements, no console errors. Keep the code compact — no dead code or long comments.`;
}

export function buildPagePrompt(storyboard: string): string {
  return `Storyboard:\n\n${storyboard.trim()}\n\nBuild the page now. Output only the HTML document.`;
}

/** Revision contract (the current HTML is passed as the content to revise). */
export const INTERACTIVE_REVISE_FORMAT =
  "Return ONLY the complete revised HTML document — start with <!DOCTYPE html>, end with </html>, no markdown fences or commentary. Keep every hard requirement: fully self-contained (no external resources or network), no storage/alert/forms, CSS color variables with a :root[data-theme=\"dark\"] override.";

/**
 * Pull the HTML document out of a model reply (fences, preamble). Throws when
 * the page is missing or was cut off before </html> — a truncated page would
 * render half a script and fail silently.
 */
export function extractHtml(raw: string): string {
  let text = raw.trim();
  const fenced = text.match(/```(?:html)?\s*\n([\s\S]*?)(?:```|$)/i);
  if (fenced && !/^<!doctype|^<html/i.test(text)) text = fenced[1].trim();
  const start = text.search(/<!doctype html|<html[\s>]/i);
  if (start < 0) throw new Error("The model didn't return a web page — try again.");
  text = text.slice(start);
  const end = text.toLowerCase().lastIndexOf("</html>");
  if (end < 0)
    throw new Error(
      "The page was cut off before it was finished — the model ran out of output room. Raise Max output in Settings → AI Model, try a narrower topic, or use a model with a larger output limit."
    );
  return text.slice(0, end + "</html>".length);
}

/**
 * Stream the page build and return the extracted HTML. llm.ts sizes the
 * output to the model's own limit; progress reports the characters written
 * so far so the job row can show the page growing.
 */
export async function writePage(opts: {
  provider: Provider;
  apiKey: string;
  model: string;
  temperature?: number;
  thinking?: Thinking;
  maxOutput?: number | null;
  messages: LlmMessage[];
  signal: AbortSignal;
  onUsage?: (usage: StreamUsage) => void;
  onProgress?: (chars: number) => void;
}): Promise<string> {
  const { onProgress, ...request } = opts;
  let out = "";
  let reported = 0;
  for await (const delta of streamChat(request)) {
    out += delta;
    if (onProgress && Date.now() - reported > 400) {
      reported = Date.now();
      onProgress(out.length);
    }
  }
  return extractHtml(out);
}

/* --------------------------------- sandbox --------------------------------- */

/** postMessage type the sandboxed page uses to report runtime errors. */
export const INTERACTIVE_ERROR_MESSAGE = "brewlm-interactive-error";

/**
 * Network is off for the page: only inline script/style and data:/blob: media.
 * Belt and braces with the iframe's opaque-origin sandbox, which already keeps
 * it away from the app's storage, keys and DOM.
 */
const PAGE_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";

/** The page as the iframe gets it: CSP, theme and an error reporter injected at the top of <head>. */
export function sandboxDoc(html: string, dark: boolean): string {
  const theme = dark ? "dark" : "light";
  const head = `<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">
<meta name="color-scheme" content="${theme}">
<script>(function(){document.documentElement.setAttribute("data-theme","${theme}");
var send=function(m){try{parent.postMessage({type:"${INTERACTIVE_ERROR_MESSAGE}",message:String(m).slice(0,400)},"*")}catch(e){}};
addEventListener("error",function(e){send((e.message||"Script error")+(e.lineno?" (line "+e.lineno+")":""))});
addEventListener("unhandledrejection",function(e){send((e.reason&&e.reason.message)||e.reason||"Unhandled promise rejection")});
addEventListener("securitypolicyviolation",function(e){send("Blocked loading "+(e.blockedURI||"a resource")+" - the page must be fully self-contained")});})();</script>`;
  const m = html.match(/<head[^>]*>/i);
  if (m && m.index !== undefined) {
    const at = m.index + m[0].length;
    return html.slice(0, at) + head + html.slice(at);
  }
  return head + html;
}
