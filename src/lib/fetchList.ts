/**
 * /fetch: a list of web sources the user can look over and add to the
 * notebook. The list is saved in the chat as an ordinary assistant message:
 * a hidden marker carries the items for the cards, and a plain markdown list
 * follows it, which is what the model sees in later turns.
 */

export type FetchKind = "paper" | "article" | "tutorial" | "video" | "docs" | "course" | "reference" | "other";

export interface FetchItem {
  title: string;
  url: string;
  kind: FetchKind;
  /** One sentence on what the source offers ("" when unknown). */
  why: string;
}

export interface FetchList {
  query: string;
  items: FetchItem[];
}

const KINDS: FetchKind[] = ["paper", "article", "tutorial", "video", "docs", "course", "reference", "other"];
export const FETCH_MAX = 10;
const MARKER_RE = /^<!--brewlm-fetch:([\s\S]*?)-->\n?/;

/** A loose identity for a URL, so the same page matches across small spelling differences. */
export function urlKey(url: string): string {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    for (const p of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(p)) u.searchParams.delete(p);
    const q = u.searchParams.toString();
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}${q ? `?${q}` : ""}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/** The site a URL lives on, for the card's subtitle. */
export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function asKind(v: unknown, url: string): FetchKind {
  const k = typeof v === "string" ? (v.toLowerCase().trim() as FetchKind) : null;
  if (k && k !== "other" && KINDS.includes(k)) return k;
  if (/youtube\.com|youtu\.be|vimeo\.com/i.test(url)) return "video";
  if (/arxiv\.org|doi\.org|\.pdf($|\?)/i.test(url)) return "paper";
  return "other";
}

/**
 * Turn the model's JSON pick into the final list. Only URLs the search
 * actually returned are kept (a model can invent links), unless the
 * provider reported no results at all. A short pick is topped up with the
 * remaining search results.
 */
export function buildFetchItems(
  picked: unknown,
  hits: { title: string; url: string }[],
  max = FETCH_MAX
): FetchItem[] {
  const hitByKey = new Map<string, { title: string; url: string }>();
  for (const h of hits) if (/^https?:\/\//i.test(h.url)) hitByKey.set(urlKey(h.url), h);
  const out: FetchItem[] = [];
  const seen = new Set<string>();
  const push = (item: FetchItem) => {
    const k = urlKey(item.url);
    if (seen.has(k) || out.length >= max) return;
    seen.add(k);
    out.push(item);
  };
  if (Array.isArray(picked)) {
    for (const p of picked) {
      if (!p || typeof p !== "object") continue;
      const r = p as Record<string, unknown>;
      const url = typeof r.url === "string" ? r.url.trim() : "";
      if (!/^https?:\/\//i.test(url)) continue;
      const hit = hitByKey.get(urlKey(url));
      if (hitByKey.size > 0 && !hit) continue;
      const title = (typeof r.title === "string" && r.title.trim()) || hit?.title || siteOf(url);
      push({
        title: title.trim(),
        url: hit?.url ?? url,
        kind: asKind(r.kind, url),
        why: typeof r.why === "string" ? r.why.trim() : "",
      });
    }
  }
  if (out.length < 5) {
    for (const h of hits) {
      if (!/^https?:\/\//i.test(h.url)) continue;
      push({ title: (h.title || siteOf(h.url)).trim(), url: h.url, kind: asKind(undefined, h.url), why: "" });
    }
  }
  return out;
}

/** The chat message for a list: marker for the cards, markdown for the model and exports. */
export function encodeFetchMessage(list: FetchList): string {
  const json = JSON.stringify(list).replace(/--/g, "\\u002d\\u002d");
  const lines = list.items.map(
    (it, i) => `${i + 1}. [${it.title.replace(/[[\]]/g, "")}](${it.url})${it.why ? ` — ${it.why}` : ""}`
  );
  return `<!--brewlm-fetch:${json}-->\nSources found for “${list.query}”:\n${lines.join("\n")}`;
}

/** The list inside a /fetch message, or null for any other message. */
export function parseFetchMessage(content: string): FetchList | null {
  const m = MARKER_RE.exec(content);
  if (!m) return null;
  try {
    const v = JSON.parse(m[1]) as FetchList;
    if (typeof v?.query !== "string" || !Array.isArray(v.items)) return null;
    return v;
  } catch {
    return null;
  }
}

/** What the model sees of a message in later turns: a /fetch list without its marker. */
export function stripFetchMarker(content: string): string {
  return content.replace(MARKER_RE, "");
}
