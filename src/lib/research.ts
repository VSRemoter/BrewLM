import { complete, extractJson, type StreamUsage } from "./llm";
import { openRouterPrefs, routingError } from "./routing";
import { aiConfigNow, openRouterApi } from "./brewlmAi";
import { activeKey, noKeyMessage, researchModelFor } from "./settings";
import { buildFetchItems, FETCH_MAX, type FetchItem } from "./fetchList";
import { contextBudget } from "./local";
import { fetchLinkContent } from "./source";
import type { Provider, Settings } from "./types";
import { recordUsage, type UsageSink } from "./usage";
import { configuredService, searchWithService, serviceSetupProblem } from "./webSearch";

/** Parse token usage out of a non-streaming provider response, when present. */
function usageFromJson(provider: Provider, json: unknown): StreamUsage {
  const u = (json as { usage?: Record<string, number> })?.usage;
  if (!u || typeof u !== "object") return {};
  if (provider === "anthropic") {
    return {
      input: u.input_tokens,
      output: u.output_tokens,
      cachedRead: u.cache_read_input_tokens,
      cachedWrite: u.cache_creation_input_tokens,
    };
  }
  return {
    input: u.prompt_tokens ?? u.input_tokens,
    output: u.completion_tokens ?? u.output_tokens,
    cachedRead: (u.prompt_tokens_details as { cached_tokens?: number } | undefined)?.cached_tokens ?? u.cache_read_input_tokens,
    costUsd: typeof u.cost === "number" ? u.cost : undefined,
  };
}

/** Ledger entry for one research call, also handed to the caller's per-output total. */
function noteUsage(provider: Provider, model: string, u: StreamUsage, sink?: UsageSink) {
  void recordUsage("research", provider, model, u);
  sink?.(provider, model, u);
}

/** Throws a recognisable AbortError so the caller can tell cancel from failure. */
function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

export interface WebHit {
  title: string;
  url: string;
  /** The search service's excerpt, when there is one. */
  snippet?: string;
}

export interface ReadPage {
  title: string;
  url: string;
  text: string;
}

export interface ResearchOutcome {
  markdown: string;
  /** Pages actually read (may be empty if every fetch failed) */
  pages: ReadPage[];
  /** All discovered links (fallback citation pool) */
  hits: WebHit[];
}

const MAX_QUERIES = 6;
const MAX_PAGES = 6;
const PAGE_CHAR_CAP = 8000;

/* ------------------------- provider-native web search ------------------------- */

interface UrlCitation {
  url?: string;
  title?: string;
}

/** A failed OpenRouter search, explained when the user's provider routing left no provider. */
async function openRouterSearchError(res: Response, model: string): Promise<Error> {
  const detail = await res.text().catch(() => "");
  return new Error((await routingError(detail, model)) || `web search failed (HTTP ${res.status})`);
}

/** The OpenRouter-format providers: the user's own OpenRouter key, or BrewLM AI. */
type OrProvider = "openrouter" | "brewlm";

/** OpenRouter "web" plugin: annotations on the assistant message. */
async function searchOpenRouter(
  query: string,
  via: OrProvider,
  apiKey: string,
  model: string,
  signal?: AbortSignal,
  onUsage?: UsageSink
): Promise<WebHit[]> {
  const provider = via === "openrouter" ? await openRouterPrefs(model) : null;
  const api = openRouterApi(via, apiKey);
  const res = await fetch(`${api.base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${api.key}`,
      ...api.headers,
    },
    body: JSON.stringify({
      model,
      ...(provider ? { provider } : {}),
      plugins: [{ id: "web", max_results: 5 }],
      messages: [
        {
          role: "user",
          content: `Search the web for: ${query}\nList the most relevant results with URLs.`,
        },
      ],
    }),
    signal,
  });
  if (!res.ok) throw await openRouterSearchError(res, model);
  const json = await res.json();
  noteUsage(via, model, usageFromJson(via, json), onUsage);
  const msg = json.choices?.[0]?.message;
  const hits = collectCitations(msg?.annotations);
  // Some models (Claude through the web plugin) sometimes answer with the
  // links in their text and no citations; the pages are fetched and checked
  // next, so a link the model got wrong just drops out.
  return hits.length ? hits : linksInText(String(msg?.content ?? ""));
}

/** Markdown links and bare http(s) URLs in a reply, first mention of each. */
export function linksInText(text: string): WebHit[] {
  const out: WebHit[] = [];
  const seen = new Set<string>();
  const add = (url: string, title?: string) => {
    const u = url.replace(/[).,;:!?'"\]]+$/, "");
    if (!/^https?:\/\/[^\s/]+\.[^\s]+/.test(u) || seen.has(u)) return;
    seen.add(u);
    out.push({ title: title?.trim() || u, url: u });
  };
  for (const m of text.matchAll(/\[([^\]]{1,300})\]\((https?:\/\/[^\s)]+)\)/g)) add(m[2], m[1]);
  for (const m of text.matchAll(/https?:\/\/[^\s<>()\[\]"'`]+/g)) add(m[0]);
  return out;
}

/** OpenAI: search-preview model emits url_citation annotations. */
async function searchOpenAI(
  query: string,
  apiKey: string,
  signal?: AbortSignal,
  onUsage?: UsageSink
): Promise<WebHit[]> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-search-preview",
      messages: [
        {
          role: "user",
          content: `Search the web for: ${query}\nList the most relevant results with URLs.`,
        },
      ],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`web search failed (HTTP ${res.status})`);
  const json = await res.json();
  noteUsage("openai", "gpt-4o-mini-search-preview", usageFromJson("openai", json), onUsage);
  return collectCitations(json.choices?.[0]?.message?.annotations);
}

function collectCitations(annotations: unknown): WebHit[] {
  const out: WebHit[] = [];
  if (!Array.isArray(annotations)) return out;
  for (const a of annotations) {
    const c: UrlCitation | undefined = (a as { url_citation?: UrlCitation })?.url_citation;
    if (c?.url && /^https?:\/\//.test(c.url)) {
      out.push({ title: (c.title ?? c.url).trim() || c.url, url: c.url });
    }
  }
  return out;
}

/** Anthropic: server-side web_search tool returns result blocks with URLs. */
async function searchAnthropic(
  query: string,
  apiKey: string,
  model: string,
  signal?: AbortSignal,
  onUsage?: UsageSink
): Promise<WebHit[]> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      messages: [{ role: "user", content: `Search the web for: ${query}` }],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`web search failed (HTTP ${res.status})`);
  const json = await res.json();
  noteUsage("anthropic", model, usageFromJson("anthropic", json), onUsage);
  const out: WebHit[] = [];
  for (const block of json.content ?? []) {
    // results of the tool calls
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) {
        if (r.type === "web_search_result" && r.url) {
          out.push({ title: String(r.title ?? r.url), url: String(r.url) });
        }
      }
    }
    // citations embedded in the final text
    if (block.type === "text" && Array.isArray(block.citations)) {
      for (const c of block.citations) {
        if (c.url) out.push({ title: String(c.title ?? c.url), url: String(c.url) });
      }
    }
  }
  return out;
}

/**
 * Why web search can't run with these settings, as a message for the user;
 * null when it can. A chosen search service works with any chat provider;
 * Automatic needs a cloud provider's own search.
 */
export function searchUnavailable(settings: Settings): string | null {
  const problem = serviceSetupProblem(settings);
  if (problem) return `${problem}. Finish it in Settings → AI Model → Web search, or set it back to Automatic.`;
  if (settings.searchService === "auto" && settings.provider === "local")
    return "Web search with a local model needs a search service. Pick SearXNG (self-hosted), Brave Search or Tavily in Settings → AI Model → Web search.";
  return null;
}

/** True when search goes through a chosen service rather than the provider's own search. */
function usesService(settings: Settings): boolean {
  return settings.searchService !== "auto";
}

async function searchWeb(
  query: string,
  settings: Settings,
  signal?: AbortSignal,
  onUsage?: UsageSink
): Promise<WebHit[]> {
  if (usesService(settings)) return searchWithService(query, settings, { count: 8, signal });
  if (settings.provider === "anthropic" && settings.anthropicKey)
    return searchAnthropic(query, settings.anthropicKey, researchModelFor(settings), signal, onUsage);
  if (settings.provider === "openai" && settings.openaiKey)
    return searchOpenAI(query, settings.openaiKey, signal, onUsage);
  if (settings.provider === "openrouter" && settings.openrouterKey)
    return searchOpenRouter(query, "openrouter", settings.openrouterKey, researchModelFor(settings), signal, onUsage);
  // BrewLM AI searches on its cheap reader model; planning and writing use the stronger one.
  if (settings.provider === "brewlm") return searchOpenRouter(query, "brewlm", "", aiConfigNow().roles.research.reader, signal, onUsage);
  return [];
}

/* ----------------------- one-shot web answers (/search) ----------------------- */

export interface WebAnswerOutcome {
  text: string;
  hits: WebHit[];
}

/** Knobs for the one-shot calls; /search uses the defaults, /fetch wants more results. */
interface AnswerOpts {
  /** Most links kept from the citations (default 8). */
  cap?: number;
  /** Anthropic: web searches the model may run (default 5). */
  searches?: number;
  /** OpenRouter: results the web plugin returns (default 5). */
  webResults?: number;
  /** Anthropic: how text blocks are glued (citations split one answer into many). */
  joinText?: string;
}

function dedupeHits(hits: WebHit[], cap = 8): WebHit[] {
  const seen = new Set<string>();
  const out: WebHit[] = [];
  for (const h of hits) {
    const u = normalizeUrl(h.url);
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push({ title: h.title || u, url: u });
    if (out.length >= cap) break;
  }
  return out;
}

/** Anthropic: one answer with server-side web search; citations from the blocks. */
async function answerAnthropic(
  query: string,
  apiKey: string,
  model: string,
  system: string | undefined,
  signal?: AbortSignal,
  opts: AnswerOpts = {}
): Promise<WebAnswerOutcome> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: system || undefined,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: opts.searches ?? 5 }],
      messages: [{ role: "user", content: query }],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`web search failed (HTTP ${res.status})`);
  const json = await res.json();
  void recordUsage("research", "anthropic", model, usageFromJson("anthropic", json));
  const texts: string[] = [];
  const hits: WebHit[] = [];
  for (const block of json.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
      if (Array.isArray(block.citations)) {
        for (const c of block.citations) {
          if (c.url) hits.push({ title: String(c.title ?? c.url), url: String(c.url) });
        }
      }
    }
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) {
        if (r.type === "web_search_result" && r.url) {
          hits.push({ title: String(r.title ?? r.url), url: String(r.url) });
        }
      }
    }
  }
  return { text: texts.join(opts.joinText ?? "\n\n").trim(), hits: dedupeHits(hits, opts.cap) };
}

/** OpenAI: the search-preview chat model answers with url_citation annotations. */
async function answerOpenAI(
  query: string,
  apiKey: string,
  system: string | undefined,
  signal?: AbortSignal,
  opts: AnswerOpts = {}
): Promise<WebAnswerOutcome> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-search-preview",
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: query },
      ],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`web search failed (HTTP ${res.status})`);
  const json = await res.json();
  void recordUsage("research", "openai", "gpt-4o-mini-search-preview", usageFromJson("openai", json));
  const msg = json.choices?.[0]?.message;
  return {
    text: String(msg?.content ?? "").trim(),
    hits: dedupeHits(collectCitations(msg?.annotations), opts.cap),
  };
}

/** OpenRouter: current model + the "web" plugin; citations from annotations. */
async function answerOpenRouter(
  query: string,
  via: OrProvider,
  apiKey: string,
  model: string,
  system: string | undefined,
  signal?: AbortSignal,
  opts: AnswerOpts = {}
): Promise<WebAnswerOutcome> {
  const provider = via === "openrouter" ? await openRouterPrefs(model) : null;
  const api = openRouterApi(via, apiKey);
  const res = await fetch(`${api.base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${api.key}`,
      ...api.headers,
    },
    body: JSON.stringify({
      model,
      ...(provider ? { provider } : {}),
      plugins: [{ id: "web", max_results: opts.webResults ?? 5 }],
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: query },
      ],
    }),
    signal,
  });
  if (!res.ok) throw await openRouterSearchError(res, model);
  const json = await res.json();
  void recordUsage("research", via, model, usageFromJson(via, json));
  const msg = json.choices?.[0]?.message;
  return {
    text: String(msg?.content ?? "").trim(),
    hits: dedupeHits(collectCitations(msg?.annotations), opts.cap),
  };
}

/** One call to the research model (the chat provider, local or cloud). */
function askModel(
  settings: Settings,
  prompt: string,
  opts: { system?: string; signal?: AbortSignal; onUsage?: UsageSink } = {}
): Promise<string> {
  const key = activeKey(settings);
  if (!key) throw new Error(noKeyMessage(settings));
  const model = researchModelFor(settings);
  return complete({
    provider: settings.provider,
    apiKey: key,
    model,
    thinking: settings.thinking,
    maxOutput: settings.maxOutput,
    temperature: settings.temperature ?? undefined,
    signal: opts.signal,
    onUsage: (u) => noteUsage(settings.provider, model, u, opts.onUsage),
    messages: [
      ...(opts.system ? [{ role: "system" as const, content: opts.system }] : []),
      { role: "user" as const, content: prompt },
    ],
  });
}

/** Pages read for a /search answer: the top few results, the rest stay as snippets. */
const ANSWER_PAGES = 3;

/**
 * /search through a search service: search, read the top pages, and answer
 * with the chat model, citing results by number. Web material gets half the
 * model's source budget; searchTurn gives the notebook the other half.
 */
async function answerWithService(
  question: string,
  settings: Settings,
  system: string | undefined,
  signal?: AbortSignal
): Promise<WebAnswerOutcome> {
  const results = await searchWithService(question, settings, { count: 6, signal });
  if (results.length === 0) return { text: "", hits: [] };
  const share = Math.floor(contextBudget(settings).sources / 2);
  const read = await Promise.all(
    results.slice(0, ANSWER_PAGES).map((r) =>
      fetchLinkContent(r.url)
        .then((p) => p.text)
        .catch(() => "")
    )
  );
  throwIfAborted(signal);
  const perPage = Math.floor(share / ANSWER_PAGES);
  const material = results
    .map((r, i) => {
      const body = (read[i] ?? "").trim().length > 200 ? read[i].slice(0, perPage) : r.snippet;
      return `### [${i + 1}] ${r.title}\nURL: ${r.url}\n\n${body}`;
    })
    .join("\n\n---\n\n")
    .slice(0, share);
  const text = await askModel(
    settings,
    `${question.trim()}

Answer using the web results below, which are current. Cite them inline as [1], [2] by their numbers. If they don't answer the question, say so.

# Web results
${material}`,
    { system, signal }
  );
  return { text: text.trim(), hits: results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })) };
}

/**
 * One web-grounded answer to a question (`/search`). Distinct from deepResearch:
 * single search round, inline answer for chat — no planning, no page reads,
 * no report. Paid per web query by the provider, so it only runs on demand.
 */
export async function webAnswer(opts: {
  query: string;
  settings: Settings;
  /** Persona/grounding system prompt (chat's own, so context can blend). */
  system?: string;
  signal?: AbortSignal;
}): Promise<WebAnswerOutcome> {
  const { query, settings, system, signal } = opts;
  const blocked = searchUnavailable(settings);
  if (blocked) throw new Error(blocked);
  if (usesService(settings)) return answerWithService(query, settings, system, signal);
  const q = `${query.trim()}\n\n(Answer using current information from the web.)`;
  if (settings.provider === "anthropic" && settings.anthropicKey)
    return answerAnthropic(q, settings.anthropicKey, researchModelFor(settings), system, signal);
  if (settings.provider === "openai" && settings.openaiKey)
    return answerOpenAI(q, settings.openaiKey, system, signal);
  if (settings.provider === "openrouter" && settings.openrouterKey)
    return answerOpenRouter(q, "openrouter", settings.openrouterKey, researchModelFor(settings), system, signal);
  if (settings.provider === "brewlm") return answerOpenRouter(q, "brewlm", "", researchModelFor(settings), system, signal);
  throw new Error("Add an API key in Settings first — web search runs through your provider.");
}

/* ------------------------ source finding (/fetch) ------------------------ */

/**
 * Web sources worth adding to the notebook for a learning request (`/fetch`).
 * One search round on the research model; the model picks and describes the
 * best results, and only links the search really returned are kept.
 */
export async function fetchSources(opts: {
  request: string;
  settings: Settings;
  signal?: AbortSignal;
}): Promise<FetchItem[]> {
  const { request, settings, signal } = opts;
  const prompt = `Someone wants web sources to learn from. Their request: "${request.trim()}"

Search the web and pick the ${FETCH_MAX - 4}–${FETCH_MAX} most useful sources for it. Aim for a mix: the primary source when there is one (e.g. the original paper or official docs), clear explainers and tutorials, solid reference pages, and good videos or courses when they exist. Prefer substantive, trustworthy pages; skip SEO filler, forums with no real answer, and paywalled or login-only pages.

Reply with ONLY a JSON array, no other text:
[{"title": "page title", "url": "https://...", "kind": "paper|article|tutorial|video|docs|course|reference|other", "why": "one short sentence on what this source gives the learner"}]
Use only URLs that appeared in your search results, exactly as they appeared.`;
  const blocked = searchUnavailable(settings);
  if (blocked) throw new Error(blocked);
  const knobs: AnswerOpts = { cap: 40, searches: 4, webResults: 10, joinText: "" };
  let out: WebAnswerOutcome;
  if (usesService(settings)) {
    // The service searches; the chat model picks from what it found.
    const results = await searchWithService(request, settings, { count: 15, signal });
    if (results.length === 0) return [];
    const list = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet.slice(0, 300)}` : ""}`).join("\n");
    const text = await askModel(
      settings,
      prompt.replace("Search the web and pick", "From the search results below, pick").replace(
        "Use only URLs that appeared in your search results, exactly as they appeared.",
        `Use only URLs from these results, exactly as written.\n\n# Search results\n${list}`
      ),
      { signal }
    );
    out = { text, hits: results.map((r) => ({ title: r.title, url: r.url })) };
  } else if (settings.provider === "anthropic" && settings.anthropicKey)
    out = await answerAnthropic(prompt, settings.anthropicKey, researchModelFor(settings), undefined, signal, knobs);
  else if (settings.provider === "openai" && settings.openaiKey)
    out = await answerOpenAI(prompt, settings.openaiKey, undefined, signal, knobs);
  else if (settings.provider === "openrouter" && settings.openrouterKey)
    out = await answerOpenRouter(prompt, "openrouter", settings.openrouterKey, researchModelFor(settings), undefined, signal, knobs);
  else if (settings.provider === "brewlm")
    out = await answerOpenRouter(prompt, "brewlm", "", researchModelFor(settings), undefined, signal, knobs);
  else throw new Error("Add an API key in Settings first — /fetch searches the web through your provider.");
  let picked: unknown = null;
  try {
    picked = JSON.parse(extractJson(out.text));
  } catch {
    /* no usable JSON — fall back to the raw search results */
  }
  return buildFetchItems(picked, out.hits);
}

/* ------------------------------- pipeline ------------------------------- */

function normalizeUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

export async function deepResearch(opts: {
  settings: Settings;
  title: string;
  description: string;
  onPhase?: (phase: string) => void;
  /** Cancel mid-pipeline — an AbortError propagates to the caller. */
  signal?: AbortSignal;
  /** Every model call's usage, for the report's own cost total. */
  onUsage?: UsageSink;
}): Promise<ResearchOutcome> {
  const { settings, title, description, signal, onPhase = () => {}, onUsage } = opts;
  const blocked = searchUnavailable(settings);
  if (blocked) throw new Error(blocked);
  if (!activeKey(settings)) throw new Error(noKeyMessage(settings));
  const budget = contextBudget(settings);

  const ask = (prompt: string, system?: string): Promise<string> => askModel(settings, prompt, { system, signal, onUsage });

  // 1. plan searches
  onPhase("Planning searches…");
  let queries: string[] = [];
  try {
    const raw = await ask(
      `Turn this research request into 3–${MAX_QUERIES} focused web search queries covering different angles (overview, key details, recent developments, criticisms/limitations).

Research topic: ${title}
${description ? `Details: ${description}` : ""}

Return ONLY a JSON array of query strings, e.g. ["query one", "query two"].`
    );
    const parsed = JSON.parse(extractJson(raw));
    if (Array.isArray(parsed)) {
      queries = parsed
        .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
        .map((q) => q.trim())
        .slice(0, MAX_QUERIES);
    }
  } catch (e) {
    /* planning fell through — fall back to the topic itself; a cancel must propagate */
    if (e instanceof Error && e.name === "AbortError") throw e;
  }
  if (queries.length === 0) queries = [title];

  // 2. search the web (dedupe by URL)
  const seen = new Set<string>();
  const hits: WebHit[] = [];
  for (let i = 0; i < queries.length; i++) {
    throwIfAborted(signal);
    onPhase(`Searching ${i + 1}/${queries.length}: ${queries[i]}`);
    try {
      for (const h of await searchWeb(queries[i], settings, signal, onUsage)) {
        const u = normalizeUrl(h.url);
        if (!u || seen.has(u)) continue;
        seen.add(u);
        hits.push({ title: h.title || u, url: u });
      }
    } catch (e) {
      /* one failing query shouldn't sink the run — but a cancel should */
      if (e instanceof Error && e.name === "AbortError") throw e;
    }
  }
  if (hits.length === 0)
    throw new Error(
      configuredService(settings)
        ? "Web search returned no results — try rephrasing the topic."
        : "Web search returned no results. This provider's search access may be unavailable — try rephrasing the topic or another provider."
    );

  // 3. read top pages directly (no CORS via the Tauri HTTP plugin)
  const pages: ReadPage[] = [];
  const targets = hits.slice(0, MAX_PAGES);
  for (let i = 0; i < targets.length; i++) {
    throwIfAborted(signal);
    onPhase(`Reading ${i + 1}/${targets.length}: ${targets[i].title}`);
    try {
      const { title: t, text } = await fetchLinkContent(targets[i].url);
      if (text.trim().length > 200) {
        pages.push({
          title: t || targets[i].title,
          url: targets[i].url,
          text: text.slice(0, PAGE_CHAR_CAP),
        });
      }
    } catch {
      /* unreadable page — skip */
    }
  }

  // 3b. small context windows (local models): notes on each page instead of the page.
  const perPage = Math.max(1500, Math.floor(budget.sources / Math.max(1, pages.length)));
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    if (p.text.length <= perPage) continue;
    throwIfAborted(signal);
    onPhase(`Taking notes ${i + 1}/${pages.length}: ${p.title}`);
    try {
      const notes = await ask(
        `Research topic: ${title}${description ? `\nDetails: ${description}` : ""}

From the web page below, write notes on everything relevant to the topic: facts, figures, dates, names, claims and caveats. At most ${Math.round(perPage / 6)} words, as plain bullet points, no preface.

# ${p.title}
${p.text.slice(0, budget.condenseGroup)}`
      );
      p.text = (notes.trim() || p.text).slice(0, perPage);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") throw e;
      p.text = p.text.slice(0, perPage);
    }
  }

  // 4. synthesize
  const readingMaterial =
    pages.length > 0
      ? pages
          .map((p, i) => `### [${i + 1}] ${p.title}\nURL: ${p.url}\n\n${p.text}`)
          .join("\n\n---\n\n")
      : hits
          .slice(0, 12)
          .map((h, i) => `### [${i + 1}] ${h.title}\nURL: ${h.url}`)
          .join("\n\n---\n\n");

  throwIfAborted(signal);
  onPhase("Writing report…");
  const markdown = (
    await ask(
      `Research request: ${title}
${description ? `Details: ${description}` : ""}

Below is material gathered from the web. Write a thorough, well-structured research report in GitHub-flavored markdown.

Requirements:
- 600–1200 words, organized with ## section headings by theme.
- Base every concrete claim on the material below; when sources disagree, say so.
- Cite claims inline with bracketed numbers like [1], [2] matching the material's numbering.
- End with a "## Sources" section: a numbered markdown list "N. [title](url)" for every source you cited.
- No preface, no "here is the report", no trailing questions.${
        pages.length === 0
          ? "\n- NOTE: only link-level information was available (pages could not be fetched); state this caveat in one sentence at the top."
          : ""
      }

# Web material
${readingMaterial}`
    )
  ).trim();

  if (markdown.length < 50) throw new Error("The report came back empty — try again.");
  return { markdown, pages, hits };
}
