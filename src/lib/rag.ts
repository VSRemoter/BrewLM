/**
 * Retrieval over notebook sources ("local RAG").
 *
 * Instead of feeding each source's first ~6k chars to the model (and silently
 * dropping everything past a global cap), sources are split into ~1.2k-char
 * chunks stored in SQLite (`source_chunks`). At prompt time the chunks most
 * relevant to the user's message fill the same context budget, so a 400-page
 * PDF is searchable end-to-end while token costs stay flat.
 *
 * Ranking: embedding cosine similarity when an embeddings API is reachable
 * (OpenAI direct, or `openai/text-embedding-3-small` via OpenRouter — both
 * cost fractions of a cent per source); otherwise a pure-JS BM25 fallback
 * keeps retrieval working for Anthropic-only users and offline sessions.
 */

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import {
  chunksForNotebook,
  chunksForSource,
  getSetting,
  indexedSourceIds,
  replaceChunks,
  setSetting,
  unembeddedSourceIds,
  uid,
} from "./db";
import { complete } from "./llm";
import { activeKey, loadSettings } from "./settings";
import type { Settings, Source, SourceChunk } from "./types";

const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 150;
const EMBED_BATCH = 64;
const EMBED_MODEL_OR = "openai/text-embedding-3-small";
const EMBED_MODEL_OAI = "text-embedding-3-small";
const EMBED_DIMS = 512;
/** Above this much source text, report tools condense instead of retrieving. */
export const MAP_REDUCE_THRESHOLD = 45_000;

/** True for sources that carry prompt-usable text (not constitutions/binaries). */
export const isRetrievable = (s: Source) =>
  s.type !== "context" && s.content.length > 0 && !s.content.startsWith("data:");

/* -------------------------------- chunking -------------------------------- */

export interface RawChunk {
  seq: number;
  page: number | null;
  text: string;
}

/** Split source text into overlapping chunks, tracking `[Page N]` markers. */
export function chunkText(text: string): RawChunk[] {
  const markers: { pos: number; page: number }[] = [];
  for (const m of text.matchAll(/\[Page (\d+)\]/g)) {
    markers.push({ pos: m.index ?? 0, page: Number(m[1]) });
  }
  const pageAt = (pos: number): number | null => {
    let page: number | null = null;
    for (const mk of markers) {
      if (mk.pos <= pos) page = mk.page;
      else break;
    }
    return page;
  };

  const out: RawChunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length);
    if (end < text.length) {
      // End on a paragraph/sentence/word boundary when one is nearby.
      const window = text.slice(start, end);
      const cut = Math.max(
        window.lastIndexOf("\n\n"),
        window.lastIndexOf(". "),
        window.lastIndexOf(" ")
      );
      if (cut > CHUNK_SIZE * 0.5) end = start + cut + 1;
    }
    const body = text.slice(start, end).trim();
    if (body) out.push({ seq: out.length, page: pageAt(start), text: body });
    if (end >= text.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return out;
}

/* ------------------------------- embeddings ------------------------------- */

interface EmbedTarget {
  url: string;
  key: string;
  model: string;
}

/** Candidate embeddings providers, best first; returns null when none work. */
function embedTargets(s: Settings): EmbedTarget[] {
  const targets: EmbedTarget[] = [];
  if (s.provider === "openai" && s.openaiKey)
    targets.push({
      url: "https://api.openai.com/v1/embeddings",
      key: s.openaiKey,
      model: EMBED_MODEL_OAI,
    });
  if (s.openrouterKey)
    targets.push({
      url: "https://openrouter.ai/api/v1/embeddings",
      key: s.openrouterKey,
      model: EMBED_MODEL_OR,
    });
  if (s.provider === "anthropic" && s.openaiKey)
    targets.push({
      url: "https://api.openai.com/v1/embeddings",
      key: s.openaiKey,
      model: EMBED_MODEL_OAI,
    });
  return targets;
}

/** Embed a batch of texts; null → caller should use the BM25 fallback. */
async function embedBatch(texts: string[], targets: EmbedTarget[]): Promise<number[][] | null> {
  for (const t of targets) {
    try {
      const res = await tauriFetch(t.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t.key}` },
        body: JSON.stringify({ model: t.model, input: texts, dimensions: EMBED_DIMS }),
        connectTimeout: 30000,
      });
      if (!res.ok) continue;
      const json = (await res.json()) as { data?: { embedding?: unknown }[] };
      if (
        Array.isArray(json.data) &&
        json.data.length === texts.length &&
        json.data.every((d) => Array.isArray(d?.embedding))
      ) {
        return json.data.map((d) => d.embedding as number[]);
      }
    } catch {
      /* try the next target */
    }
  }
  return null;
}

async function embedAll(texts: string[], settings: Settings): Promise<number[][] | null> {
  const targets = embedTargets(settings);
  if (targets.length === 0) return null;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = await embedBatch(texts.slice(i, i + EMBED_BATCH), targets);
    if (!batch) return null; // partial embeddings are worse than none — go full BM25
    out.push(...batch);
  }
  return out;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/* ------------------------------ BM25 fallback ----------------------------- */

function tokenize(t: string): string[] {
  return t.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
}

function bm25Scores(docs: string[], query: string): number[] {
  const qTerms = [...new Set(tokenize(query))];
  const dToks = docs.map(tokenize);
  const N = docs.length;
  const avgdl = dToks.reduce((s, t) => s + t.length, 0) / Math.max(1, N);
  const df = new Map<string, number>();
  for (const toks of dToks) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const k1 = 1.5;
  const b = 0.75;
  return dToks.map((toks) => {
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const term of qTerms) {
      const f = tf.get(term);
      if (!f) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * toks.length) / avgdl));
    }
    return score;
  });
}

/* -------------------------------- helpers --------------------------------- */

/** Run `fn` over `items` with at most `size` in flight; order-preserving. */
async function mapPool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

/* -------------------------------- indexing -------------------------------- */

/** Session-level guards against duplicate work / retry storms. */
const inFlight = new Set<string>();
/** Backfill attempts: `sourceId:providerFingerprint` — once per key per session. */
const backfillAttempts = new Set<string>();

/**
 * Chunk + embed one source into `source_chunks`. Failures log and move on.
 * With `onlyIfEmbeddable` (backfill mode): requires a configured embeddings
 * provider, and a failed embed leaves any existing BM25 chunks untouched.
 */
export async function indexSource(
  source: Source,
  settings?: Settings,
  opts: { onlyIfEmbeddable?: boolean } = {}
): Promise<void> {
  if (!isRetrievable(source) || inFlight.has(source.id)) return;
  const s = settings ?? (await loadSettings());
  // Backfill is pointless with no provider — and a storm guard relies on it.
  if (opts.onlyIfEmbeddable && embedTargets(s).length === 0) return;
  inFlight.add(source.id);
  try {
    const raw = chunkText(source.content);
    if (raw.length === 0) return;
    const embeddings = await embedAll(
      raw.map((c) => c.text),
      s
    );
    // Backfill with a still-broken provider: keep today's BM25 rows as-is.
    if (opts.onlyIfEmbeddable && !embeddings) return;
    const chunks: SourceChunk[] = raw.map((c, i) => ({
      id: uid(),
      source_id: source.id,
      notebook_id: source.notebook_id,
      seq: c.seq,
      page: c.page,
      text: c.text,
      embedding: embeddings ? JSON.stringify(embeddings[i]) : "",
    }));
    await replaceChunks(chunks);
  } catch (e) {
    console.warn("rag: failed to index", source.title, e);
  } finally {
    inFlight.delete(source.id);
  }
}

/**
 * Index any retrievable source that lacks chunks (new sources and, for
 * existing users, anything saved before retrieval existed). Sequential on
 * purpose — gentle on rate limits. Then, when an embeddings provider is
 * configured, upgrade stale BM25-only chunks to real embeddings — at most
 * once per key per app session, so a broken key never storms.
 */
export async function ensureIndexed(sources: Source[], settings?: Settings): Promise<void> {
  const textual = sources.filter(isRetrievable);
  if (textual.length === 0) return;
  const notebookId = textual[0].notebook_id;
  const s = settings ?? (await loadSettings());

  const indexed = await indexedSourceIds(notebookId);
  for (const src of textual.filter((x) => !indexed.has(x.id))) {
    await indexSource(src, s);
  }

  // Stale-embedding backfill.
  const targets = embedTargets(s);
  if (targets.length === 0) return;
  const fingerprint = `${s.provider}:${targets.map((t) => t.key.slice(-4)).join(",")}`;
  const stale = await unembeddedSourceIds(notebookId);
  for (const src of textual) {
    const attemptKey = `${src.id}:${fingerprint}`;
    if (!stale.has(src.id) || backfillAttempts.has(attemptKey)) continue;
    backfillAttempts.add(attemptKey);
    await indexSource(src, s, { onlyIfEmbeddable: true });
  }
}

/* -------------------------------- retrieval ------------------------------- */

export interface RetrievedChunk {
  id: string;
  sourceId: string;
  sourceTitle: string;
  sourceType: string;
  page: number | null;
  text: string;
  score: number;
}

/* ----------------- positional (head/tail) safety net ------------------ */

/**
 * Positional questions ("what's the LAST sentence?", "how does it END?")
 * are invisible to relevance scoring — the final page shares no words or
 * embedding-neighborhood with the words "last sentence". When the query
 * asks about a document boundary, always include the boundary chunks of the
 * source(s) in play, alongside whatever relevance retrieval found.
 */
const TAIL_RE =
  /\b(last|final|finally|latest|end|ending|conclusion|concluding|epilogue|afterword)\b/i;
const HEAD_RE =
  /\b(first|begin|beginning|start|starting|opening|introduction|preface|prologue)\b/i;

function boundaryChunks(
  live: SourceChunk[],
  rankedSourceIds: string[],
  query: string
): SourceChunk[] {
  const tail = TAIL_RE.test(query);
  const head = HEAD_RE.test(query);
  if (!tail && !head) return [];

  const bySource = new Map<string, SourceChunk[]>();
  for (const c of live) {
    const arr = bySource.get(c.source_id) ?? [];
    arr.push(c);
    bySource.set(c.source_id, arr);
  }
  // Focus on the sources the user is most likely asking about (top-ranked);
  // with no signal at all, the biggest indexed source (e.g. the one big book).
  const seen = new Set<string>();
  const focus = rankedSourceIds
    .filter((id) => bySource.has(id) && !seen.has(id) && seen.add(id))
    .slice(0, 2);
  if (focus.length === 0) {
    const largest = [...bySource.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    if (largest) focus.push(largest[0]);
  }

  const out: SourceChunk[] = [];
  for (const id of focus) {
    const sorted = [...(bySource.get(id) ?? [])].sort((a, b) => a.seq - b.seq);
    if (head) out.push(...sorted.slice(0, 2));
    if (tail) out.push(...sorted.slice(-2));
  }
  return out;
}

/**
 * The most relevant chunks for `query`, capped by total characters.
 * Positional queries (last/first/end…) additionally get the document's
 * boundary chunks, packed before relevance fill so they can't be starved.
 * Empty result = no usable signal (caller falls back to legacy truncation).
 */
export async function rankChunks(
  sources: Source[],
  query: string,
  settings: Settings | undefined,
  maxChars: number
): Promise<RetrievedChunk[]> {
  const notebookId = sources[0]?.notebook_id;
  if (!notebookId || !query.trim()) return [];
  const chunks = await chunksForNotebook(notebookId);
  if (chunks.length === 0) return [];
  const byId = new Map(sources.map((s) => [s.id, s]));
  const live = chunks.filter((c) => byId.has(c.source_id));
  if (live.length === 0) return [];

  const s = settings ?? (await loadSettings());
  const scored: { c: (typeof live)[number]; score: number }[] = [];

  // Vector path — only when both sides can be embedded.
  if (live.some((c) => c.embedding)) {
    const qv = (await embedAll([query.slice(0, 2000)], s))?.[0];
    if (qv) {
      for (const c of live) {
        if (!c.embedding) continue;
        try {
          scored.push({ c, score: cosine(qv, JSON.parse(c.embedding) as number[]) });
        } catch {
          /* corrupt embedding row — BM25 will cover it */
        }
      }
    }
  }

  const boundary = boundaryChunks(
    live,
    scored.map((x) => x.c.source_id),
    query
  );

  // BM25 fallback (also when some chunks lack embeddings).
  if (scored.length < live.length * 0.5) {
    scored.length = 0;
    bm25Scores(
      live.map((c) => c.text),
      query
    ).forEach((score, i) => {
      if (score > 0) scored.push({ c: live[i], score });
    });
  }

  scored.sort((a, b) => b.score - a.score);
  // Boundary chunks FIRST: they must be packed before the ranked fill can
  // consume the whole budget — a positional question needs the document's
  // actual end/beginning, not whatever remains after relevance spending.
  const ordered = [...boundary.map((c) => ({ c, score: 0 })), ...scored];
  const picked = new Set<string>();
  const out: RetrievedChunk[] = [];
  let used = 0;
  for (const { c, score } of ordered) {
    if (picked.has(c.id)) continue;
    const cost = c.text.length + 48;
    if (out.length > 0 && used + cost > maxChars) continue; // smaller chunks may still fit
    const src = byId.get(c.source_id);
    if (!src) continue;
    picked.add(c.id);
    out.push({
      id: c.id,
      sourceId: c.source_id,
      sourceTitle: src.title,
      sourceType: src.type,
      page: c.page,
      text: c.text,
      score,
    });
    used += cost;
    if (used >= maxChars) break;
  }
  return out;
}

/* ------------------------- map-reduce condensation ------------------------ */

const MAP_GROUP_CHARS = 20_000;
const MAX_GROUPS_PER_LEVEL = 60;
/** Parallel condense calls per pass — keeps a whole-book condense under a minute. */
const CONDENSE_POOL = 4;

interface CondenseItem {
  label: string;
  text: string;
}

/**
 * Reduce `items` to ≤ targetChars of dense notes via repeated LLM passes.
 * Each pass groups items up to MAP_GROUP_CHARS and condenses each group, so
 * arbitrarily large material converges (400-page PDF: ~100 groups → ~7 notes).
 */
async function condenseTo(
  items: CondenseItem[],
  settings: Settings,
  focus: string,
  targetChars: number
): Promise<string> {
  const goal = focus || "a comprehensive, detailed representation of the full notebook material";
  let notes = items;
  for (let pass = 0; pass < 4; pass++) {
    const joined = notes.map((n) => `### ${n.label}\n${n.text}`).join("\n\n");
    if (joined.length <= targetChars) return joined;

    const groups: CondenseItem[] = [];
    let cur: CondenseItem | null = null;
    for (const item of notes) {
      if (cur && cur.text.length + item.text.length > MAP_GROUP_CHARS) {
        groups.push(cur);
        cur = { label: item.label, text: item.text };
      } else if (cur) {
        cur = { label: cur.label, text: `${cur.text}\n\n${item.text}` };
      } else {
        cur = { label: item.label, text: item.text };
      }
    }
    if (cur) groups.push(cur);

    const next = await mapPool(groups.slice(0, MAX_GROUPS_PER_LEVEL), CONDENSE_POOL, async (g) => {
      const note = (
        await complete({
          provider: settings.provider,
          apiKey: activeKey(settings),
          model: settings.model,
          maxTokens: 1024,
          messages: [
            {
              role: "user",
              content:
                `Below is an excerpt from "${g.label}". Extract everything relevant to ${goal} ` +
                `as dense bullet notes (max 400 words): key facts, arguments, figures, dates, names, ` +
                `definitions, caveats. Quote specifics exactly; write nothing that isn't in the excerpt.\n\n${g.text}`,
            },
          ],
        })
      ).trim();
      return { label: g.label, text: note };
    });
    if (next.length === 0) return joined.slice(0, targetChars);
    notes = next;
  }
  return notes.map((n) => `### ${n.label}\n${n.text}`).join("\n\n").slice(0, targetChars);
}

/**
 * Exhaustive coverage of every source (chunk-level), for notebook-wide
 * reports on material far larger than any context window. Returns notes
 * grounded in the sources, grouped under their titles.
 */
export async function condenseSources(
  sources: Source[],
  settings: Settings,
  focus: string,
  onPhase?: (phase: string) => void
): Promise<string> {
  const textual = sources.filter(isRetrievable).slice(0, 12);
  // Chunk-level starting points keep even huge single sources fully covered.
  const items: CondenseItem[] = [];
  for (const src of textual) {
    const chunks = await chunksForSource(src.id);
    const bodies = chunks.length
      ? chunks.map((c) => c.text)
      : [src.content.slice(0, MAP_GROUP_CHARS)];
    // Pre-group chunks so level 1 starts near MAP_GROUP_CHARS per item.
    let cur = "";
    for (const b of bodies) {
      if (cur && cur.length + b.length > MAP_GROUP_CHARS) {
        items.push({ label: src.title, text: cur });
        cur = b;
      } else {
        cur = cur ? `${cur}\n\n${b}` : b;
      }
    }
    if (cur) items.push({ label: src.title, text: cur });
  }
  onPhase?.(`Condensing ${textual.length} sources (full coverage)…`);
  return condenseTo(items, settings, focus, 28_000);
}

/** Changes whenever a source is added, removed, or its content edited. */
function notebookSignature(sources: Source[]): string {
  return sources
    .filter(isRetrievable)
    .map((s) => `${s.id}:${s.content.length}`)
    .sort()
    .join("|");
}

/**
 * Focus-neutral whole-notebook condensation, cached per notebook content
 * state in the settings table. The expensive map-reduce runs once; every
 * Studio tool (report, flashcards, quiz, mindmap, audio) then reuses the
 * same notes until any source changes.
 */
export async function condenseNotebook(
  notebookId: string,
  sources: Source[],
  settings: Settings,
  onPhase?: (phase: string) => void
): Promise<string> {
  const sig = notebookSignature(sources);
  const cacheKey = `condense.${notebookId}`;
  try {
    const raw = await getSetting(cacheKey);
    if (raw) {
      const cached = JSON.parse(raw) as { sig?: string; notes?: string };
      if (cached.sig === sig && typeof cached.notes === "string" && cached.notes.length > 0) {
        return cached.notes;
      }
    }
  } catch {
    /* cache miss or corrupt entry — recompute */
  }
  const notes = await condenseSources(sources, settings, "", onPhase);
  try {
    await setSetting(cacheKey, JSON.stringify({ sig, notes }));
  } catch {
    /* caching is best-effort */
  }
  return notes;
}

/** System-prompt wrapper for condensed notebook notes (shared by all tools). */
export function condensedSystemPrompt(notes: string): string {
  return `You are BrewLM, a thoughtful study assistant. Below are condensed notes covering EVERY source in the notebook (produced by a full pass over the material). Treat them as the authoritative content of the notebook; cite facts to the listed source titles.\n\n${notes}`;
}
