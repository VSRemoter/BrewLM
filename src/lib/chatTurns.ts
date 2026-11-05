/**
 * Chat commands shared by the desktop chat (ChatPanel) and chats from a paired
 * phone (jobRunner): pictures (/image /edit /remix /more), one-shot web
 * answers (/search), source finding (/fetch), the notebook toggles (/ground,
 * /constitution) and /summarize. Each turn returns the reply to save; real
 * failures throw (an AbortError when cancelled).
 */
import { getImage } from "./db";
import { fetchSources, webAnswer } from "./research";
import { encodeFetchMessage } from "./fetchList";
import { imageRef, imageIdsIn, libraryImageAsReference, saveImageToLibrary } from "./genImage";
import {
  editCapableModels,
  generateImages,
  isImageApiModel,
  maxImagesPerRequest,
  maxInputReferences,
  supportedAspectRatios,
} from "./imageApi";
import { buildSystemPrompt } from "../components/ChatPanel";
import type { MentionItem } from "./mentions";
import { contextBudget } from "./local";
import { ensureIndexed, rankChunks, type RetrievedChunk } from "./rag";
import { recordUsage } from "./usage";
import type { ChatMessage, Settings, Source } from "./types";

function aborted(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

/** Strip one pair of matching outer quotes: /fetch "…" / /rename "…". */
export function stripOuterQuotes(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "“" && s.endsWith("”")))) {
    return s.slice(1, -1).trim();
  }
  return s;
}

/* -------------------------------- pictures -------------------------------- */

const IMAGE_CMD = /^\/(image|img|edit|remix|more)(?=\s|$)/i;

/** An image command, or a plain message while an image model is the chat model. */
export async function isImageTurn(text: string, settings: Settings): Promise<boolean> {
  if (IMAGE_CMD.test(text)) return true;
  return !text.startsWith("/") && settings.provider === "openrouter" && (await isImageApiModel(settings.model));
}

/**
 * Image API turns, each carrying ONLY the prompt (no sources, no history):
 * /image draws fresh; /edit and /remix add the single picture being changed
 * as a reference; /more reruns a picture's stored prompt. Every picture costs
 * just the image, and later chat turns see a one-line description of it,
 * never the pixels. With an image model selected as the active model, plain
 * messages work the same way — and a message right after a picture edits
 * that picture. `history` ends with this turn's user message.
 */
export async function imageTurn(opts: {
  text: string;
  history: ChatMessage[];
  settings: Settings;
  notebookId: string;
  chatId: string;
  /** The picture a hover action picked; else the chat's latest one. */
  imageId?: string;
  signal: AbortSignal;
}): Promise<string> {
  const { text, history, settings, notebookId, chatId, signal } = opts;
  const activeIsImageModel = settings.provider === "openrouter" && (await isImageApiModel(settings.model));
  const imgCmd = IMAGE_CMD.exec(text)?.[1].toLowerCase();
  let prompt = imgCmd ? text.replace(/^\/\w+\s*/, "").trim() : text;
  let ratio: string | undefined;
  const rm = /^(\d+(?:\.\d+)?:\d+(?:\.\d+)?)(\s+|$)/.exec(prompt);
  if (rm) {
    ratio = rm[1];
    prompt = prompt.slice(rm[0].length).trim();
  }
  // The selected model wins when it is an image model; otherwise the
  // dedicated Image model setting.
  let model = activeIsImageModel ? settings.model : settings.imageModel;
  let mode: "new" | "edit" | "remix" | "more" =
    imgCmd === "edit" || imgCmd === "remix" || imgCmd === "more" ? imgCmd : "new";
  let targetId: string | undefined;
  if (mode !== "new") {
    targetId = opts.imageId;
    for (let i = history.length - 1; !targetId && i >= 0; i--) {
      if (history[i].role === "assistant") targetId = imageIdsIn(history[i].content).pop();
    }
  }
  // Plain message right after a picture → edit that picture (when the
  // model can take a reference; otherwise it simply draws fresh).
  let followUp = false;
  const prev = history[history.length - 2];
  if (!imgCmd && prev?.role === "assistant" && (await maxInputReferences(model)) > 0) {
    const prevId = imageIdsIn(prev.content).pop();
    if (prevId) {
      mode = "edit";
      targetId = prevId;
      followUp = true;
    }
  }
  const source = targetId ? await getImage(targetId) : null;
  if (followUp && !source) {
    mode = "new"; // picture above is gone — just draw fresh
    followUp = false;
  }

  if (!settings.openrouterKey)
    return "Pictures use OpenRouter's image models. Add an OpenRouter API key in **Settings → AI Model** (select OpenRouter to enter it — you can switch your chat provider back afterwards).";
  if (mode === "new" && !prompt)
    return "What should I draw? e.g. `/image a watercolor fox in snow`, or add a shape first: `/image 16:9 a misty mountain lake at dawn`.";
  if (mode !== "new" && !targetId) return "There's no picture in this chat yet — make one first with `/image <prompt>`.";
  if (mode !== "new" && !source) return "That picture is no longer in the image library, so there's nothing to work from.";
  if ((mode === "edit" || mode === "remix") && !prompt)
    return mode === "edit"
      ? "What should I change? e.g. `/edit make the sky stormy` or `/edit remove the text`."
      : "What should the remix be? e.g. `/remix same style, but a city at night`.";

  // "More like this" stays on the model that drew the original.
  if (mode === "more" && source && source.model !== model && (await isImageApiModel(source.model))) {
    model = source.model;
  }
  const canReference = (await maxInputReferences(model)) > 0;
  if ((mode === "edit" || mode === "remix") && !canReference) {
    const alts = (await editCapableModels()).map((m) => `\`${m}\``).join(", ");
    return `**${model}** can't edit pictures — it doesn't accept a reference image. ${
      alts ? `Models that can: ${alts}. ` : ""
    }Pick one under **Settings → AI Model → Image model**${activeIsImageModel ? " or switch with `/model <id>`" : ""}.`;
  }

  // The one picture sent as a reference: the target for edit/remix;
  // for "more", whatever the original itself was made from.
  const refId =
    mode === "edit" || mode === "remix" ? source!.id : mode === "more" && canReference ? source!.parent_id : "";
  const refUri = refId ? await libraryImageAsReference(refId) : null;
  const apiPrompt =
    mode === "more"
      ? source!.prompt
      : mode === "remix"
        ? `Create a new image inspired by the reference image (keep its style and mood): ${prompt}`
        : prompt;
  // Keep the original's shape unless the user named one.
  if (!ratio && source && source.width > 0 && source.height > 0) {
    const want = source.width / source.height;
    const best = (await supportedAspectRatios(model))
      ?.map((r) => {
        const [w, h] = r.split(":").map(Number);
        return { r, diff: Math.abs(w / h - want) / want };
      })
      .filter((x) => Number.isFinite(x.diff))
      .sort((a, b) => a.diff - b.diff)[0];
    if (best && best.diff < 0.05) ratio = best.r;
  }
  const result = await generateImages({
    apiKey: settings.openrouterKey,
    model,
    prompt: apiPrompt,
    aspectRatio: ratio,
    references: refUri ? [refUri] : undefined,
    n: mode === "more" ? Math.min(2, await maxImagesPerRequest(model)) : 1,
    signal,
  });
  if (signal.aborted) throw aborted();
  void recordUsage("image", "openrouter", model, result.usage);
  // Alt text is the description later chat turns see.
  const alt =
    mode === "edit"
      ? `${prompt} (edit of: ${source!.prompt})`
      : mode === "remix"
        ? `${prompt} (remix of: ${source!.prompt})`
        : apiPrompt;
  const refs: string[] = [];
  for (const uri of result.images) {
    const id = await saveImageToLibrary(uri, {
      notebookId,
      chatId,
      prompt: apiPrompt,
      model,
      parentId: refUri ? refId : undefined,
    });
    refs.push(imageRef(id, alt));
  }
  const cost = result.usage.costUsd;
  const label = { new: null, edit: "edit", remix: "remix", more: "more like this" }[mode];
  const caption = [label, model, result.aspectRatio, cost != null ? `$${cost.toFixed(3)}` : null]
    .filter(Boolean)
    .join(" · ");
  const unsupported =
    ratio && !result.aspectRatio && rm ? ` — ${ratio} isn't available on this model, so it used its default shape` : "";
  const hint = followUp ? " — edited the picture above; start with `/image` for a fresh one" : "";
  return `${refs.join("\n\n")}\n\n*${caption}${unsupported}*${hint}`;
}

/* --------------------------------- /fetch --------------------------------- */

/** /fetch <request> — web sources to learn from, as a card list the user adds from. */
export async function fetchTurn(opts: { request: string; settings: Settings; signal: AbortSignal }): Promise<string> {
  const request = stripOuterQuotes(opts.request.trim());
  if (!request)
    return "What do you want to learn about? e.g. `/fetch \"Attention Is All You Need\"` or `/fetch how transformers work in LLMs`. I'll find sources you can open and add to this notebook.";
  const items = await fetchSources({ request, settings: opts.settings, signal: opts.signal });
  if (opts.signal.aborted) throw aborted();
  return items.length > 0
    ? encodeFetchMessage({ query: request, items })
    : `I couldn't find sources for “${request}”. Your provider's web search may have come back empty — try rephrasing, or use \`/url <link>\` to add a page you already know.`;
}

/* --------------------------------- /search -------------------------------- */

/**
 * /search <query> — one-shot web answer with cited links (provider search,
 * billed per query). Grounded like chat, so web results can weave into the
 * notebook's own context.
 */
export async function searchTurn(opts: {
  query: string;
  settings: Settings;
  sources: Source[];
  mentioned: MentionItem[];
  grounded: boolean;
  constitution: boolean;
  signal: AbortSignal;
}): Promise<string> {
  const { query, settings, sources, signal } = opts;
  if (!query.trim())
    return "What should I look up? e.g. `/search best budget e-ink tablets 2026`. For a deep multi-source dossier saved to Studio, use `/research <topic>` instead.";
  let retrieved: RetrievedChunk[] | undefined;
  if (opts.grounded) {
    try {
      await ensureIndexed(sources, settings);
      const ranked = await rankChunks(sources, query, settings, contextBudget(settings).sources);
      if (ranked.length > 0) retrieved = ranked;
    } catch {
      /* search proceeds without notebook context */
    }
  }
  const { text: answer, hits } = await webAnswer({
    query,
    settings,
    system: buildSystemPrompt(sources, opts.mentioned, retrieved, {
      grounded: opts.grounded,
      constitution: opts.constitution,
      budget: contextBudget(settings),
    }),
    signal,
  });
  if (signal.aborted) throw aborted();
  let body = answer || "(no answer came back — try rephrasing)";
  if (hits.length > 0) {
    body += `\n\n---\n\n##### Sources from the web\n${hits.map((h, i) => `${i + 1}. [${h.title}](${h.url})`).join("\n")}`;
  }
  return body;
}

/* ----------------------------- notebook toggles ---------------------------- */

/** The reply after /ground switches grounding to `on`. */
export function groundReply(on: boolean): string {
  return on
    ? `📚 Grounding **on** — answers will be grounded in your sources and cite them. (\`/ground\` toggles this.)`
    : `🌐 Grounding **off** — I'll answer from my own knowledge and skip your sources entirely (cheaper and faster — no retrieval runs). @mention a source anytime to pull it into a single answer. (\`/ground\` toggles this.)`;
}

/**
 * /constitution [on|off]: the reply, and the setting to save (null = leave it).
 * `isOn` is the current setting; `has` whether the notebook has a constitution.
 */
export function constitutionTurn(arg: string, isOn: boolean, has: boolean): { reply: string; next: boolean | null } {
  const a = arg.trim().toLowerCase();
  if (!has)
    return {
      reply:
        "This notebook has no constitution, so there's nothing to turn on or off. Add one from the **+** menu in the Sources panel → **Add constitution**.",
      next: null,
    };
  if (a && a !== "on" && a !== "off")
    return {
      reply: `Use \`/constitution on\` or \`/constitution off\` — or just \`/constitution\` to flip it. It's currently **${isOn ? "on" : "off"}**.`,
      next: null,
    };
  const next = a === "on" ? true : a === "off" ? false : !isOn;
  return {
    reply: next
      ? `🏛️ Constitution **on** — replies follow this notebook's constitution again. (\`/constitution\` toggles this.)`
      : `Constitution **off** — replies ignore it until you turn it back on. Your constitution is still in the Sources panel, untouched. (\`/constitution\` toggles this.)`,
    next: next === isOn ? null : next,
  };
}

/* -------------------------------- /summarize ------------------------------- */

export const SUMMARIZE_RE = /^\/summarize(\s|$)/i;

/** What the model gets in place of "/summarize" (the bubble keeps the command). */
export const SUMMARIZE_PROMPT =
  "Write a clear, well-structured summary of this whole notebook: the core ideas, why they matter, and the key details worth remembering. Cover every source.";
