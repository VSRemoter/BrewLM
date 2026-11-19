/**
 * Web search services that don't depend on the AI provider (Settings → AI
 * Model → Web search): a self-hosted SearXNG, or a Brave Search or Tavily
 * key. With one set, research, /search and /fetch search through it and the
 * chat model (local or cloud) reads and writes; with Automatic, each cloud
 * provider's own search is used, as before (research.ts).
 *
 * Requests go through the app's own HTTP client: SearXNG and Brave don't
 * allow browser requests, and a self-hosted SearXNG is on this computer.
 */
import { platform } from "../platform";
import type { SearchService, Settings } from "./types";

export interface SearchResult {
  title: string;
  url: string;
  /** The service's short excerpt of the page ("" when it gives none). */
  snippet: string;
}

export const SEARCH_SERVICE_LABELS: Record<SearchService, string> = {
  auto: "Automatic",
  searxng: "SearXNG",
  brave: "Brave Search",
  tavily: "Tavily",
};

type SearchSettings = Pick<Settings, "searchService" | "searxngUrl" | "braveKey" | "tavilyKey">;

/** The service to search with, or null when it's Automatic or isn't set up. */
export function configuredService(s: SearchSettings): Exclude<SearchService, "auto"> | null {
  switch (s.searchService) {
    case "searxng":
      return s.searxngUrl.trim() ? "searxng" : null;
    case "brave":
      return s.braveKey.trim() ? "brave" : null;
    case "tavily":
      return s.tavilyKey.trim() ? "tavily" : null;
    default:
      return null;
  }
}

/** What's missing for the chosen service, in words; null when it's ready (or Automatic). */
export function serviceSetupProblem(s: SearchSettings): string | null {
  if (s.searchService === "auto" || configuredService(s)) return null;
  return s.searchService === "searxng"
    ? "SearXNG is picked for web search but has no address yet"
    : `${SEARCH_SERVICE_LABELS[s.searchService]} is picked for web search but has no API key yet`;
}

/** "localhost:8888/" → "http://localhost:8888" (SearXNG is served at the root, not /v1). */
export function normalizeSearxngUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "").replace(/\/search$/i, "");
  if (url && !/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url;
}

/** Results with a usable http(s) URL, first of each, at most `count`. */
export function cleanResults(raw: { title?: unknown; url?: unknown; snippet?: unknown }[], count: number): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const url = typeof r.url === "string" ? r.url.trim() : "";
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const strip = (v: unknown) => (typeof v === "string" ? v.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "");
    out.push({ title: strip(r.title) || url, url, snippet: strip(r.snippet) });
    if (out.length >= count) break;
  }
  return out;
}

async function getJson(url: string, init: RequestInit, signal: AbortSignal | undefined, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await platform.fetch(url, { ...init, signal, connectTimeout: 10000 });
  } catch (e) {
    if (signal?.aborted || (e instanceof Error && e.name === "AbortError")) throw new DOMException("Aborted", "AbortError");
    throw new Error(`Couldn't reach ${what}. ${what === "SearXNG" ? "Is it running?" : "Check your internet connection."}`);
  }
  if (res.status === 401 || res.status === 403) {
    if (what === "SearXNG")
      throw new Error("SearXNG refused the request. Turn on its JSON output: add `json` to `search: formats:` in its settings.yml, then restart it.");
    throw new Error(`${what} rejected the API key.`);
  }
  if (res.status === 429) throw new Error(`${what} says too many searches: you've hit your plan's rate limit. Try again shortly.`);
  if (!res.ok) throw new Error(`${what} answered HTTP ${res.status}.`);
  try {
    return await res.json();
  } catch {
    throw new Error(
      what === "SearXNG"
        ? "SearXNG didn't answer with JSON. Check the address, and that `json` is in `search: formats:` in its settings.yml."
        : `${what} sent a reply BrewLM couldn't read.`
    );
  }
}

/** Search with the configured service. Throws a readable error; [] = nothing found. */
export async function searchWithService(
  query: string,
  s: SearchSettings,
  opts: { count?: number; signal?: AbortSignal } = {}
): Promise<SearchResult[]> {
  const count = opts.count ?? 8;
  const service = configuredService(s);
  if (!service) throw new Error(serviceSetupProblem(s) ?? "No web search service is set up.");
  if (service === "searxng") {
    const base = normalizeSearxngUrl(s.searxngUrl);
    const json = (await getJson(
      `${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1`,
      { headers: { Accept: "application/json" } },
      opts.signal,
      "SearXNG"
    )) as { results?: { title?: string; url?: string; content?: string }[] };
    return cleanResults((json.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })), count);
  }
  if (service === "brave") {
    const json = (await getJson(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(20, count)}`,
      { headers: { Accept: "application/json", "X-Subscription-Token": s.braveKey.trim() } },
      opts.signal,
      "Brave Search"
    )) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
    return cleanResults((json.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.description })), count);
  }
  const json = (await getJson(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.tavilyKey.trim()}` },
      body: JSON.stringify({ query, max_results: Math.min(20, count), search_depth: "basic" }),
    },
    opts.signal,
    "Tavily"
  )) as { results?: { title?: string; url?: string; content?: string }[] };
  return cleanResults((json.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })), count);
}
