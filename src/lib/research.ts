import { complete, extractJson } from "./llm";
import { activeKey } from "./settings";
import { fetchLinkContent } from "./source";
import type { Settings } from "./types";

/** Throws a recognisable AbortError so the caller can tell cancel from failure. */
function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

export interface WebHit {
  title: string;
  url: string;
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

/** OpenRouter "web" plugin: annotations on the assistant message. */
async function searchOpenRouter(
  query: string,
  apiKey: string,
  model: string,
  signal?: AbortSignal
): Promise<WebHit[]> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://brewlm.app",
      "X-Title": "BrewLM",
    },
    body: JSON.stringify({
      model,
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
  if (!res.ok) throw new Error(`web search failed (HTTP ${res.status})`);
  const json = await res.json();
  return collectCitations(json.choices?.[0]?.message?.annotations);
}

/** OpenAI: search-preview model emits url_citation annotations. */
async function searchOpenAI(query: string, apiKey: string, signal?: AbortSignal): Promise<WebHit[]> {
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
  signal?: AbortSignal
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

async function searchWeb(query: string, settings: Settings, signal?: AbortSignal): Promise<WebHit[]> {
  if (settings.provider === "anthropic" && settings.anthropicKey)
    return searchAnthropic(query, settings.anthropicKey, settings.model, signal);
  if (settings.provider === "openai" && settings.openaiKey)
    return searchOpenAI(query, settings.openaiKey, signal);
  if (settings.provider === "openrouter" && settings.openrouterKey)
    return searchOpenRouter(query, settings.openrouterKey, settings.model, signal);
  return [];
}

/* ----------------------- one-shot web answers (/search) ----------------------- */

export interface WebAnswerOutcome {
  text: string;
  hits: WebHit[];
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
  signal?: AbortSignal
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
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      messages: [{ role: "user", content: query }],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`web search failed (HTTP ${res.status})`);
  const json = await res.json();
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
  return { text: texts.join("\n\n").trim(), hits: dedupeHits(hits) };
}

/** OpenAI: the search-preview chat model answers with url_citation annotations. */
async function answerOpenAI(
  query: string,
  apiKey: string,
  system: string | undefined,
  signal?: AbortSignal
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
  const msg = json.choices?.[0]?.message;
  return {
    text: String(msg?.content ?? "").trim(),
    hits: dedupeHits(collectCitations(msg?.annotations)),
  };
}

/** OpenRouter: current model + the "web" plugin; citations from annotations. */
async function answerOpenRouter(
  query: string,
  apiKey: string,
  model: string,
  system: string | undefined,
  signal?: AbortSignal
): Promise<WebAnswerOutcome> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://brewlm.app",
      "X-Title": "BrewLM",
    },
    body: JSON.stringify({
      model,
      plugins: [{ id: "web", max_results: 5 }],
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: query },
      ],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`web search failed (HTTP ${res.status})`);
  const json = await res.json();
  const msg = json.choices?.[0]?.message;
  return {
    text: String(msg?.content ?? "").trim(),
    hits: dedupeHits(collectCitations(msg?.annotations)),
  };
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
  const q = `${query.trim()}\n\n(Answer using current information from the web.)`;
  if (settings.provider === "anthropic" && settings.anthropicKey)
    return answerAnthropic(q, settings.anthropicKey, settings.model, system, signal);
  if (settings.provider === "openai" && settings.openaiKey)
    return answerOpenAI(q, settings.openaiKey, system, signal);
  if (settings.provider === "openrouter" && settings.openrouterKey)
    return answerOpenRouter(q, settings.openrouterKey, settings.model, system, signal);
  throw new Error("Add an API key in Settings first — web search runs through your provider.");
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
}): Promise<ResearchOutcome> {
  const { settings, title, description, signal, onPhase = () => {} } = opts;
  const key = activeKey(settings);
  if (!key) throw new Error("Add an API key first.");

  const ask = (prompt: string, system?: string): Promise<string> =>
    complete({
      provider: settings.provider,
      apiKey: key,
      model: settings.model,
      maxTokens: 4096,
      signal,
      messages: [
        ...(system ? [{ role: "system" as const, content: system }] : []),
        { role: "user" as const, content: prompt },
      ],
    });

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
      for (const h of await searchWeb(queries[i], settings, signal)) {
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
      "Web search returned no results. This provider's search access may be unavailable — try rephrasing the topic or another provider."
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
