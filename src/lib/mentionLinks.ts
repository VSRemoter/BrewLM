/**
 * @-mentions across notebooks: the library-wide index the @ menu searches,
 * looking mentioned items up again by id, and loading what the AI reads.
 *
 * How a mention reaches the model. Nothing is fetched by the model itself —
 * BrewLM reads the material from the local database before the request and
 * puts it in the system prompt's "@-mentioned materials" section:
 *
 * 1. mentionsForTurn: the refs stored with the last few user messages (and
 *    "@Title" typed by hand, matched in this notebook) become MentionItems;
 *    an item from another notebook gets its text from the database.
 * 2. prepareMentions: the mention budget is split fairly across them
 *    (shareBudget). What fits goes whole; a longer source sends its most
 *    relevant chunks (the retrieval index, rag.ts); a longer output and a
 *    mentioned notebook send the parts most relevant to the message.
 * 3. buildSystemParts (ChatPanel) writes each one under "### @Title (…)",
 *    saying which notebook it came from so the reply can cite it.
 */

import { getDb, listArtifacts, listSources, sourceText } from "./db";
import {
  artifactText,
  mentionBudget,
  parseMentionRefs,
  resolveMentions,
  shareBudget,
  type IndexItem,
  type MentionIndex,
  type MentionItem,
  type MentionRef,
} from "./mentions";
import { ensureIndexed, excerptByRelevance, isRetrievable, rankChunks } from "./rag";
import type { Artifact, ChatMessage, Settings, Source } from "./types";

/* --------------------------------- index --------------------------------- */

/** Every live notebook, folder, source and output — titles only, cheap even for a big library. */
export async function loadMentionIndex(): Promise<MentionIndex> {
  const d = await getDb();
  const [notebooks, folders, sources, outputs] = await Promise.all([
    d.select<{ id: string; title: string; folder_id: string; starred: number; updated_at: number }[]>(
      "SELECT id, title, folder_id, starred, updated_at FROM notebooks WHERE trashed_at = 0"
    ),
    d.select<{ id: string; name: string }[]>("SELECT id, name FROM folders"),
    d.select<{ id: string; notebook_id: string; title: string; type: string; created_at: number }[]>(
      `SELECT s.id, s.notebook_id, s.title, s.type, s.created_at FROM sources s
       JOIN notebooks n ON n.id = s.notebook_id AND n.trashed_at = 0`
    ),
    // Drawings stay out of @mentions: they're for the user, not the AI.
    d.select<{ id: string; notebook_id: string; title: string; kind: string; created_at: number }[]>(
      `SELECT a.id, a.notebook_id, a.title, a.kind, a.created_at FROM artifacts a
       JOIN notebooks n ON n.id = a.notebook_id AND n.trashed_at = 0 WHERE a.kind != 'drawing'`
    ),
  ]);
  const folderIds = new Set(folders.map((f) => f.id));
  return {
    notebooks: notebooks.map((n) => ({
      id: n.id,
      title: n.title,
      folderId: folderIds.has(n.folder_id) ? n.folder_id : "",
      starred: !!n.starred,
      updatedAt: n.updated_at,
    })),
    folders,
    items: [
      ...sources.map((s): IndexItem => ({ id: s.id, notebookId: s.notebook_id, title: s.title, group: "source", type: s.type, createdAt: s.created_at })),
      ...outputs.map((a): IndexItem => ({ id: a.id, notebookId: a.notebook_id, title: a.title, group: "output", type: a.kind, createdAt: a.created_at })),
    ],
  };
}

/** A panel catalog entry as an index row (this notebook's live items for the picker). */
export function catalogToIndex(catalog: MentionItem[], notebookId: string): IndexItem[] {
  return catalog
    .filter((c) => c.group !== "notebook")
    .map((c) => ({ id: c.id, notebookId, title: c.title, group: c.group as "source" | "output", type: c.type, createdAt: 0 }));
}

/* -------------------------------- lookups -------------------------------- */

const placeholders = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `$${i + from}`).join(", ");

/**
 * The state now of refs to other notebooks (or to whole notebooks): current
 * title, the notebook's title, or why it can't be read. No text. Keyed by ref id.
 */
export async function lookupRefs(refs: MentionRef[], currentNotebookId: string): Promise<Map<string, MentionItem>> {
  const out = new Map<string, MentionItem>();
  const away = refs.filter((r) => r.kind === "notebook" || r.notebookId !== currentNotebookId);
  if (away.length === 0) return out;
  const d = await getDb();
  const nbIds = [...new Set(away.map((r) => r.notebookId))];
  const srcIds = [...new Set(away.filter((r) => r.kind === "source").map((r) => r.id))];
  const outIds = [...new Set(away.filter((r) => r.kind === "output").map((r) => r.id))];
  const [nbs, srcs, outs] = await Promise.all([
    d.select<{ id: string; title: string; trashed_at: number }[]>(
      `SELECT id, title, trashed_at FROM notebooks WHERE id IN (${placeholders(nbIds.length)})`,
      nbIds
    ),
    srcIds.length
      ? d.select<{ id: string; title: string; type: string; notebook_id: string }[]>(
          `SELECT id, title, type, notebook_id FROM sources WHERE id IN (${placeholders(srcIds.length)})`,
          srcIds
        )
      : Promise.resolve([]),
    outIds.length
      ? d.select<{ id: string; title: string; kind: string; notebook_id: string }[]>(
          `SELECT id, title, kind, notebook_id FROM artifacts WHERE id IN (${placeholders(outIds.length)})`,
          outIds
        )
      : Promise.resolve([]),
  ]);
  const nbById = new Map(nbs.map((n) => [n.id, n]));
  const srcById = new Map(srcs.map((s) => [s.id, s]));
  const outById = new Map(outs.map((a) => [a.id, a]));
  for (const r of away) {
    const nb = nbById.get(r.notebookId);
    const gone = !nb ? "was deleted" : nb.trashed_at > 0 ? "is in the Trash" : undefined;
    if (r.kind === "notebook") {
      out.set(r.id, {
        id: r.id,
        title: nb?.title ?? r.title,
        matchTitle: r.title,
        group: "notebook",
        type: "notebook",
        text: null,
        notebookId: r.id,
        notebookTitle: nb?.title ?? r.title,
        missing: gone,
      });
      continue;
    }
    const row = r.kind === "source" ? srcById.get(r.id) : outById.get(r.id);
    out.set(r.id, {
      id: r.id,
      title: row?.title ?? r.title,
      matchTitle: r.title,
      group: r.kind,
      type: row ? ("type" in row ? row.type : row.kind) : r.kind,
      text: null,
      notebookId: r.notebookId,
      notebookTitle: nb?.title,
      missing: gone ?? (row ? undefined : "was deleted"),
    });
  }
  return out;
}

/**
 * Refs as items to match in a message: this notebook's from the live catalog
 * (or marked deleted), other notebooks' from `away` (lookupRefs) — or a bare
 * placeholder while that lookup is still running.
 */
export function refItems(
  refs: MentionRef[],
  currentNotebookId: string,
  catalog: MentionItem[],
  away: Map<string, MentionItem>
): MentionItem[] {
  return refs.map((r) => {
    if (r.kind !== "notebook" && r.notebookId === currentNotebookId) {
      const live = catalog.find((c) => c.id === r.id);
      return live
        ? { ...live, matchTitle: r.title }
        : { id: r.id, title: r.title, matchTitle: r.title, group: r.kind, type: r.kind, text: null, missing: "was deleted" };
    }
    return (
      away.get(r.id) ?? {
        id: r.id,
        title: r.title,
        matchTitle: r.title,
        group: r.kind,
        type: r.kind,
        text: null,
        notebookId: r.notebookId,
      }
    );
  });
}

/** Read the text of other notebooks' sources and outputs (notebooks load in prepareMentions). */
export async function loadAwayText(items: MentionItem[]): Promise<MentionItem[]> {
  const away = items.filter((m) => m.notebookId && m.group !== "notebook" && !m.missing);
  if (away.length === 0) return items;
  const d = await getDb();
  const srcIds = away.filter((m) => m.group === "source").map((m) => m.id);
  const outIds = away.filter((m) => m.group === "output").map((m) => m.id);
  const [srcs, outs] = await Promise.all([
    srcIds.length ? d.select<Source[]>(`SELECT * FROM sources WHERE id IN (${placeholders(srcIds.length)})`, srcIds) : Promise.resolve([]),
    outIds.length ? d.select<Artifact[]>(`SELECT * FROM artifacts WHERE id IN (${placeholders(outIds.length)})`, outIds) : Promise.resolve([]),
  ]);
  const text = new Map<string, string | null>();
  for (const s of srcs) {
    const t = sourceText(s);
    text.set(s.id, t && !t.startsWith("data:") ? t : null);
  }
  for (const a of outs) text.set(a.id, artifactText(a));
  return items.map((m) => (text.has(m.id) ? { ...m, text: text.get(m.id) ?? null } : m));
}

/** How many recent user messages keep their mentions in play (follow-ups stay on topic). */
const MENTION_TURNS = 8;

/**
 * What the user has @-mentioned in this conversation's recent turns: stored
 * refs first (exact items, any notebook), then "@Title" typed by hand and
 * pasted link addresses, matched in this notebook. One entry per item. An
 * item that can't be read any more is kept only from the latest message, so
 * the reply can say it's gone instead of guessing.
 */
export async function mentionsForTurn(
  history: Pick<ChatMessage, "role" | "content" | "mentions">[],
  catalog: MentionItem[],
  currentNotebookId: string
): Promise<MentionItem[]> {
  const users = history.filter((m) => m.role === "user").slice(-MENTION_TURNS);
  const refsPer = users.map((m) => parseMentionRefs(m.mentions));
  const away = await lookupRefs(refsPer.flat(), currentNotebookId);
  const seen = new Set<string>();
  const out: MentionItem[] = [];
  users.forEach((m, i) => {
    const latest = i === users.length - 1;
    for (const item of resolveMentions(m.content, [...refItems(refsPer[i], currentNotebookId, catalog, away), ...catalog])) {
      if (seen.has(item.id) || (item.missing && !latest)) continue;
      seen.add(item.id);
      out.push(item);
    }
  });
  return loadAwayText(out);
}

/* --------------------------- preparing the text --------------------------- */

/** The message without its "@Title" tokens — what retrieval should rank against. */
function retrievalQuery(text: string, items: MentionItem[]): string {
  let q = text;
  for (const m of items) for (const t of new Set([m.title, m.matchTitle ?? m.title])) q = q.split(`@${t}`).join(" ");
  return q.trim() || items.map((m) => m.title).join(" ");
}

const GAP = "\n\n[…]\n\n";

/** Excerpts of one source from the retrieval index, in reading order; [] when the index can't help. */
async function indexedExcerpts(src: Source, query: string, settings: Settings, cap: number): Promise<string> {
  try {
    await ensureIndexed([src], settings);
    const ranked = await rankChunks([src], query, settings, cap);
    if (ranked.length === 0) return "";
    const full = sourceText(src);
    const at = (t: string) => {
      const i = full.indexOf(t.slice(0, 80));
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    return ranked
      .sort((a, b) => at(a.text) - at(b.text))
      .map((c) => (c.page ? `[p. ${c.page}] ${c.text}` : c.text))
      .join(GAP);
  } catch (e) {
    console.warn("mentions: index excerpts skipped", e);
    return "";
  }
}

function fit(text: string, cap: number): string {
  return text.length > cap ? text.slice(0, Math.max(0, cap - 14)) + "\n[…truncated]" : text;
}

interface NotebookMaterial {
  sources: Source[];
  outputs: { title: string; kind: string; text: string }[];
  /** Characters needed to send all of it, headings included. */
  size: number;
}

/** `skip`: items mentioned on their own as well — they're sent there, not twice. */
async function notebookMaterial(notebookId: string, skip: Set<string>): Promise<NotebookMaterial> {
  const [allSources, artifacts] = await Promise.all([listSources(notebookId), listArtifacts(notebookId)]);
  const sources = allSources.filter((s) => isRetrievable(s) && !skip.has(s.id));
  const outputs = artifacts
    .filter((a) => a.kind !== "drawing" && !skip.has(a.id))
    .map((a) => ({ title: a.title, kind: a.kind, text: artifactText(a) ?? "" }))
    .filter((o) => o.text.trim());
  const size =
    sources.reduce((n, s) => n + sourceText(s).length + s.title.length + 32, 0) +
    outputs.reduce((n, o) => n + o.text.length + o.title.length + 32, 0) +
    600;
  return { sources, outputs, size };
}

/** "N sources: A, B, C and 4 more" — so the model knows what else is there. */
function directory(m: NotebookMaterial): string {
  const list = (titles: string[], max = 12) =>
    titles.length <= max ? titles.join(", ") : `${titles.slice(0, max).join(", ")} and ${titles.length - max} more`;
  const parts = [
    m.sources.length ? `${m.sources.length} source${m.sources.length === 1 ? "" : "s"}: ${list(m.sources.map((s) => s.title))}` : "",
    m.outputs.length ? `${m.outputs.length} saved output${m.outputs.length === 1 ? "" : "s"}: ${list(m.outputs.map((o) => o.title))}` : "",
  ].filter(Boolean);
  return fit(`Contents — ${parts.join("; ")}.`, 1200);
}

/** The notebook's material for one message: everything if it fits, else the most relevant parts of it. */
async function notebookBody(
  m: NotebookMaterial,
  query: string,
  settings: Settings,
  cap: number
): Promise<{ text: string; excerpt: boolean }> {
  if (m.sources.length === 0 && m.outputs.length === 0)
    return { text: "[Nothing else in this notebook to add: it's empty, or what it holds is @mentioned separately.]", excerpt: false };
  const dir = directory(m);
  const srcHead = (s: Source) => `#### ${s.title} (source · ${s.type})`;
  const outHead = (o: { title: string; kind: string }) => `#### ${o.title} (output · ${o.kind})`;
  if (m.size <= cap) {
    const blocks = [...m.sources.map((s) => `${srcHead(s)}\n${sourceText(s)}`), ...m.outputs.map((o) => `${outHead(o)}\n${o.text}`)];
    return { text: fit(`${dir}\n\n${blocks.join("\n\n")}`, cap), excerpt: false };
  }

  const room = Math.max(0, cap - dir.length - 64);
  const outTotal = m.outputs.reduce((n, o) => n + o.text.length + 48, 0);
  let outRoom = m.outputs.length ? Math.min(outTotal, Math.floor(room * (m.sources.length ? 0.35 : 1))) : 0;
  const srcRoom = room - outRoom;

  const srcBlocks = new Map<string, string[]>();
  let srcUsed = 0;
  if (m.sources.length && srcRoom > 0) {
    let ranked: { label: string; text: string }[] = [];
    try {
      await ensureIndexed(m.sources, settings);
      const byId = new Map(m.sources.map((s) => [s.id, s]));
      ranked = (await rankChunks(m.sources, query, settings, srcRoom)).map((c) => ({
        label: srcHead(byId.get(c.sourceId)!),
        text: c.page ? `[p. ${c.page}] ${c.text}` : c.text,
      }));
    } catch (e) {
      console.warn("mentions: notebook retrieval skipped", e);
    }
    if (ranked.length === 0) {
      ranked = excerptByRelevance(m.sources.map((s) => ({ label: srcHead(s), text: sourceText(s) })), query, srcRoom).map((c) => ({
        label: c.label,
        text: c.page ? `[p. ${c.page}] ${c.text}` : c.text,
      }));
    }
    for (const c of ranked) {
      srcBlocks.set(c.label, [...(srcBlocks.get(c.label) ?? []), c.text]);
      srcUsed += c.text.length + 8;
    }
  }
  outRoom += Math.max(0, srcRoom - srcUsed);
  const outBlocks = new Map<string, string[]>();
  if (m.outputs.length && outRoom > 0) {
    for (const c of excerptByRelevance(m.outputs.map((o) => ({ label: outHead(o), text: o.text })), query, outRoom)) {
      outBlocks.set(c.label, [...(outBlocks.get(c.label) ?? []), c.text]);
    }
  }
  const blocks = [...srcBlocks, ...outBlocks].map(([label, parts]) => `${label}\n${parts.join(GAP)}`);
  return { text: fit(`${dir}\n\n${blocks.join("\n\n")}`, cap), excerpt: true };
}

/**
 * Make each mention's text final for this message, within the mention budget.
 * `inline(m)`: its full text is already in the prompt's Sources section (the
 * whole-notebook prompt), so it needs no room here. Never throws: whatever
 * can't be read falls back to the beginning of the text.
 */
export async function prepareMentions(
  items: MentionItem[],
  opts: {
    query: string;
    settings: Settings;
    budget: { mentions: number; sources: number };
    /** This notebook's sources, for excerpting a long one through the retrieval index. */
    localSources: Source[];
    inline?: (m: MentionItem) => boolean;
  }
): Promise<MentionItem[]> {
  if (items.length === 0) return items;
  const inline = opts.inline ?? (() => false);
  const query = retrievalQuery(opts.query, items);
  const alone = new Set(items.filter((m) => m.group !== "notebook").map((m) => m.id));
  const material = await Promise.all(
    items.map((m) => (m.group === "notebook" && !m.missing ? notebookMaterial(m.id, alone).catch(() => null) : Promise.resolve(null)))
  );
  const needs = items.map((m, i) =>
    m.missing || inline(m) ? 0 : m.group === "notebook" ? material[i]?.size ?? 0 : m.text?.length ?? 0
  );
  const caps = shareBudget(needs, mentionBudget(opts.budget, items));

  return Promise.all(
    items.map(async (m, i): Promise<MentionItem> => {
      const cap = caps[i];
      if (m.missing || inline(m)) return { ...m, prepared: true };
      if (m.group === "notebook") {
        const mat = material[i];
        if (!mat) return { ...m, prepared: true, text: null };
        const body = await notebookBody(mat, query, opts.settings, cap).catch(() => ({ text: "", excerpt: false }));
        return { ...m, prepared: true, text: body.text || null, excerpt: body.excerpt };
      }
      if (!m.text || m.text.length <= cap) return { ...m, prepared: true };
      let text = "";
      if (m.group === "source") {
        const src =
          opts.localSources.find((s) => s.id === m.id) ??
          (m.notebookId ? (await (await getDb()).select<Source[]>("SELECT * FROM sources WHERE id = $1", [m.id]))[0] : undefined);
        if (src) text = await indexedExcerpts(src, query, opts.settings, Math.max(0, cap - 32));
      }
      if (!text) text = excerptByRelevance([{ label: "", text: m.text }], query, cap).map((c) => c.text).join(GAP);
      return { ...m, prepared: true, excerpt: true, text: fit(text, cap) };
    })
  );
}
