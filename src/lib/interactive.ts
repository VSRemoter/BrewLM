/**
 * Interactive Studio outputs: an AI-written, self-contained HTML page — a web
 * app, animation, game, simulation or whatever the user asks for — built from
 * their sources.
 *
 * Generation is two passes: a storyboard grounded in the sources (format,
 * facts, layout, controls), then the page built from that storyboard alone, so
 * the expensive long-output pass doesn't re-read every source. The page runs
 * in a sandboxed iframe (scripts only, opaque origin, no network) — see
 * sandboxDoc.
 */
import { streamChat, type LlmMessage, type StreamUsage } from "./llm";
import type { Provider, Thinking } from "./types";

export interface InteractiveOptions {
  /** What to build, in the user's words; empty = the model picks something fitting from the sources. */
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
}

export function parseInteractive(data: string): InteractiveData | null {
  try {
    const d = JSON.parse(data);
    if (typeof d?.html !== "string" || !d.html.trim()) return null;
    return { html: d.html, storyboard: typeof d.storyboard === "string" ? d.storyboard : "" };
  } catch {
    return null;
  }
}

/* --------------------------------- prompts --------------------------------- */

export function buildStoryboardPrompt(opts: Pick<InteractiveOptions, "topic">): string {
  const request = opts.topic.trim()
    ? `What I want: ${opts.topic.trim()}`
    : "What I want: you choose — pick the idea in my sources that gains most from being seen and played with, and the format that shows it best.";
  return `I want to turn part of my sources into an interactive web page — a web app, animation, game, simulation, explorer, quiz or whatever format fits.

${request}

Write the storyboard for it in markdown — not the code. Include:
1. **Title**, the **format** (e.g. guided animation, simulation, game, web app) and a one-sentence goal.
2. **Visual layout** — what is on screen (objects, labels, axes, colors and what each color means).
3. **Flow** — the scenes, steps, challenges or views in order: what is shown, what moves or changes, and any captions, answers or feedback.
4. **Key facts and values** — every number, unit, threshold and named structure the page must show, exactly as my sources give them.
5. **Controls** — each button, slider, toggle or input, with ranges, defaults and what it changes.
6. **Takeaways** — 3 short points the user should leave with.

Use the facts in my sources. Where the page needs a detail my sources don't give (e.g. a standard value), use the standard textbook value and mark it "(general knowledge)". Keep it under 900 words.`;
}

/** Instructions for the build pass; the storyboard goes in the user message. */
export const PAGE_SYSTEM = `You build single-file interactive web pages — web apps, animations, games, simulations and more. You follow the storyboard you are given exactly — its format, facts, values, labels and order.

Hard requirements:
- Output ONE complete HTML document and nothing else: start with <!DOCTYPE html>, end with </html>. No markdown fences, no commentary.
- Everything inline: CSS in <style>, JavaScript in <script>. No external resources of any kind — no CDNs, libraries, web fonts, images or network requests. They are blocked and the page breaks. Draw with SVG, Canvas and CSS; animate with requestAnimationFrame or CSS transitions. Use the system font stack.
- The page runs in a sandbox: do not use localStorage, sessionStorage, cookies, alert, confirm, prompt, window.open or forms.
- Fill the viewport and work from 320px wide up to a full desktop screen. No horizontal scrolling. Readable text (at least 13px), large click targets.
- Theming: define every color as a CSS variable on :root (light palette) and override them under :root[data-theme="dark"]. The host sets data-theme on <html>. Use a clear, restrained palette; color-code meaningfully and add a legend.
- Controls that fit the format: animations get Play/Pause, Back, Next, Restart, a step indicator and a speed control (Space toggles play, ←/→ step; start paused on step 1); simulations get labelled sliders/toggles with live values and units, a Reset and a few "Try this" presets; games get a Start screen, instant feedback explaining why, a visible score and a recap with Play again. Anything else gets whatever controls the storyboard describes.
- Label every structure and show values with units. Be accurate to the storyboard.
- Plain, robust JavaScript: wrap it in an IIFE, guard against null elements, no console errors. Keep the code compact — no dead code or long comments.`;

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
