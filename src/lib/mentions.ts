/**
 * @-mentions: reference sources, saved LLM outputs (artifacts) and — across
 * notebooks — whole notebooks in chat.
 *
 * A message keeps the readable "@Title" in its text. When the item was picked
 * from the @ menu, the message also stores a MentionRef (messages.mentions)
 * saying exactly which item that was, by id — so two items with the same name
 * never get confused, and an item from another notebook can be found again.
 * Text typed by hand still resolves by title, within the open notebook.
 */

import { sourceText } from "./db";
import { parseInteractive } from "./interactive";
import { documentText, parseDocument } from "./document";
import type { Artifact, Source } from "./types";

export type MentionGroup = "source" | "output" | "notebook";

export interface MentionItem {
  id: string;
  title: string;
  group: MentionGroup;
  /** Source type or artifact kind (pdf, link, flashcards, …); "notebook" for a notebook. */
  type: string;
  /** Extracted readable text; null for binary/media that has none (and for notebooks until loaded). */
  text: string | null;
  /** Link sources: the page's address, so pasting it in chat points at the source too. */
  url?: string;
  /** The "@…" text to find in a message when it isn't `title` (the item was renamed since). */
  matchTitle?: string;
  /** Lives in another notebook (for a notebook mention: that notebook's id). */
  notebookId?: string;
  /** That notebook's title, for chips and the prompt. */
  notebookTitle?: string;
  /** Can't be read any more: "was deleted", "is in the Trash". */
  missing?: string;
  /** `text` is final: the parts picked for this message, within its share of the budget. */
  prepared?: boolean;
  /** `text` holds the most relevant excerpts rather than everything. */
  excerpt?: boolean;
}

/** Which item an @mention points at, stored with the message (messages.mentions). */
export interface MentionRef {
  kind: MentionGroup;
  id: string;
  /** The notebook the item lives in (the notebook itself for kind "notebook"). */
  notebookId: string;
  /** The title as it was inserted — the "@…" to find in the message text. */
  title: string;
}

const REF_KINDS: ReadonlySet<string> = new Set(["source", "output", "notebook"]);

/** messages.mentions → refs; anything malformed is dropped. */
export function parseMentionRefs(raw: string | null | undefined): MentionRef[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (r): r is MentionRef =>
        r && REF_KINDS.has(r.kind) && typeof r.id === "string" && typeof r.notebookId === "string" &&
        typeof r.title === "string" && r.title.trim() !== ""
    );
  } catch {
    return [];
  }
}

export function serializeMentionRefs(refs: MentionRef[]): string {
  return refs.length ? JSON.stringify(refs.map(({ kind, id, notebookId, title }) => ({ kind, id, notebookId, title }))) : "";
}

/** The refs whose "@Title" is still in `text` (the user may have edited it away), one per item. */
export function keptRefs(refs: MentionRef[], text: string): MentionRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    if (seen.has(r.id)) return false;
    if (!titleRe(r.title).test(text)) return false;
    seen.add(r.id);
    return true;
  });
}

/** A download's file name: the output's title, safe on every system. */
export function exportName(title: string, ext: string): string {
  const base = title.replace(/[/\\?%*:|"<>]/g, "").trim().slice(0, 60);
  return `${base || "brewlm-output"}.${ext}`;
}

/** Flatten a saved artifact into plain text the model can read. */
export function artifactText(a: Artifact): string | null {
  try {
    switch (a.kind) {
      case "drawing":
        return null; // the user's own sketch — never sent to the AI
      case "interactive":
        // The storyboard is the readable version; the page itself is code.
        return parseInteractive(a.data)?.storyboard.trim() || null;
      case "document": {
        // Slides and sheets read as markdown; Word and Markdown files are markdown already.
        const d = parseDocument(a.data);
        return d ? documentText(d).trim() || null : null;
      }
      case "notes":
      case "report":
      case "mindmap":
        return a.data.trim() || null;
      case "research": {
        const d = JSON.parse(a.data);
        const md = typeof d?.md === "string" ? d.md.trim() : "";
        const refs = Array.isArray(d?.sources)
          ? (d.sources as { title?: string; url?: string }[])
              .filter((s) => s?.url)
              .map((s) => `- ${s.title ?? s.url} (${s.url})`)
              .join("\n")
          : "";
        return [md, refs && `\n\nSources:\n${refs}`].filter(Boolean).join("") || null;
      }
      case "audio": {
        const d = JSON.parse(a.data);
        if (!Array.isArray(d?.script)) return null;
        const lines = (d.script as { speaker?: string; text?: string }[])
          .filter((t) => typeof t?.text === "string" && t.text.trim())
          .map((t) => `${t.speaker === "Sam" ? "Co-Host" : "Host"}: ${t.text!.trim()}`);
        return lines.join("\n") || null;
      }
      case "flashcards": {
        const d = JSON.parse(a.data);
        if (!Array.isArray(d)) return null;
        const cards = (d as { front?: string; back?: string }[]).filter((c) => c?.front && c?.back);
        return cards.map((c) => `Q: ${c.front}\nA: ${c.back}`).join("\n\n") || null;
      }
      case "quiz": {
        const d = JSON.parse(a.data);
        if (!Array.isArray(d)) return null;
        const qs = d as {
          question?: string;
          options?: string[];
          answerIndex?: number;
          explanation?: string;
        }[];
        return (
          qs
            .filter((q) => q?.question && Array.isArray(q.options))
            .map((q) => {
              const opts = q.options!.map((o, i) => `  ${String.fromCharCode(65 + i)}) ${o}`);
              const answer =
                typeof q.answerIndex === "number" && q.options![q.answerIndex] != null
                  ? `Answer: ${String.fromCharCode(65 + q.answerIndex)}) ${q.options![q.answerIndex]}`
                  : "";
              return [`Q: ${q.question}`, ...opts, answer, q.explanation ? `Why: ${q.explanation}` : ""]
                .filter(Boolean)
                .join("\n");
            })
            .join("\n\n") || null
        );
      }
    }
  } catch {
    return null;
  }
}

/** Sources first, then LLM outputs — the @-mention catalog for a notebook. */
export function buildMentionCatalog(sources: Source[], artifacts: Artifact[] = []): MentionItem[] {
  return [
    ...sources.map((s) => ({
      id: s.id,
      title: s.title,
      group: "source" as const,
      type: s.type,
      text: sourceText(s) && !sourceText(s).startsWith("data:") ? sourceText(s) : null,
      ...(s.type === "link" && s.mime ? { url: s.mime } : {}),
    })),
    // Drawings stay out of @mentions: they're for the user, not the AI.
    ...artifacts.filter((a) => a.kind !== "drawing").map((a) => ({
      id: a.id,
      title: a.title,
      group: "output" as const,
      type: a.kind,
      text: artifactText(a),
    })),
  ];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "@Title" matcher: word-boundary prefix, title verbatim, boundary/EOL after. */
function titleRe(title: string): RegExp {
  return new RegExp(`(^|[\\s("'\`])@(${escapeRegExp(title)})(?=$|[\\s).,;:!?"'\`])`, "gi");
}

export interface MentionSegment {
  text: string;
  item?: MentionItem;
}

/** Split text into plain runs and @mention runs (longest titles win, no overlaps). */
export function segmentMentions(content: string, items: MentionItem[]): MentionSegment[] {
  const hits: { start: number; end: number; item: MentionItem }[] = [];
  const name = (i: MentionItem) => i.matchTitle ?? i.title;
  // Stable sort: on equal length, earlier items win (refs are passed first).
  const sorted = [...items].filter((i) => name(i).trim()).sort((a, b) => name(b).length - name(a).length);
  for (const item of sorted) {
    for (const m of content.matchAll(titleRe(name(item)))) {
      const start = m.index + m[1].length; // the "@"
      const end = start + 1 + m[2].length;
      if (hits.some((h) => start < h.end && end > h.start)) continue;
      hits.push({ start, end, item });
    }
  }
  hits.sort((a, b) => a.start - b.start);

  const out: MentionSegment[] = [];
  let pos = 0;
  for (const h of hits) {
    if (h.start > pos) out.push({ text: content.slice(pos, h.start) });
    out.push({ text: content.slice(h.start, h.end), item: h.item });
    pos = h.end;
  }
  if (pos < content.length) out.push({ text: content.slice(pos) });
  return out;
}

/** Query parameters share buttons and trackers add; they don't change the page. */
const TRACKING_PARAM_RE = /^(utm_.*|s|t|si|ref|ref_src|ref_url|fbclid|gclid|igshid|feature|share|mc_.*)$/i;

/**
 * A web address reduced to what identifies the page: no scheme, "www."/"m.",
 * trailing slash, fragment or tracking parameters ("?s=20" on X share links).
 * twitter.com and x.com are the same site.
 */
export function linkKey(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "").replace(/^twitter\.com$/, "x.com");
  const params = [...u.searchParams]
    .filter(([k]) => !TRACKING_PARAM_RE.test(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return `${host}${u.pathname.replace(/\/+$/, "").toLowerCase()}${params ? `?${params}` : ""}`;
}

/** Which catalog items the text points at, by @Title or by pasting a link source's address (deduped, first-seen order). */
export function resolveMentions(content: string, items: MentionItem[]): MentionItem[] {
  const seen = new Set<string>();
  const out: MentionItem[] = [];
  for (const seg of segmentMentions(content, items)) {
    if (seg.item && !seen.has(seg.item.id)) {
      seen.add(seg.item.id);
      out.push(seg.item);
    }
  }
  const pasted = new Set(
    (content.match(/https?:\/\/[^\s<>()"']+/gi) ?? []).map(linkKey).filter((k): k is string => !!k)
  );
  if (pasted.size > 0) {
    for (const item of items) {
      if (item.url && !seen.has(item.id) && pasted.has(linkKey(item.url) ?? "")) {
        seen.add(item.id);
        out.push(item);
      }
    }
  }
  return out;
}

/* --------------------------- cross-notebook picker --------------------------- */

export interface IndexNotebook {
  id: string;
  title: string;
  folderId: string;
  starred: boolean;
  updatedAt: number;
}

export interface IndexFolder {
  id: string;
  name: string;
}

/** A source or output anywhere in the library — titles only, no text. */
export interface IndexItem {
  id: string;
  notebookId: string;
  title: string;
  group: "source" | "output";
  type: string;
  createdAt: number;
}

/** Everything the @ menu can offer across notebooks (mentionLinks.loadMentionIndex). */
export interface MentionIndex {
  notebooks: IndexNotebook[];
  folders: IndexFolder[];
  items: IndexItem[];
}

export type PickerRow =
  /** Insert this item. `notebook` is set when it lives in another notebook. */
  | { kind: "item"; key: string; item: IndexItem; notebook?: IndexNotebook }
  /** Open the notebook to pick from its items. */
  | { kind: "notebook"; key: string; notebook: IndexNotebook; count: number }
  /** Mention the whole notebook. */
  | { kind: "whole"; key: string; notebook: IndexNotebook; count: number }
  /** Open the folder to pick one of its notebooks. */
  | { kind: "folder"; key: string; folder: IndexFolder; count: number };

/** Where the menu is browsing: inside a folder, or inside a notebook (maybe within its folder). */
export interface PickerScope {
  folder?: IndexFolder;
  notebook?: IndexNotebook;
  /** The "Folder/Notebook/" text the scope took from the query. */
  path: string;
}

/** The scope the user opened by picking a row — by id, so same-named notebooks stay apart. */
export interface ScopeHint {
  path: string;
  folderId?: string;
  notebookId?: string;
}

/** The text that opens a scope: "Folder/", "Notebook/" or "Folder/Notebook/". */
export function scopePath(folder: IndexFolder | undefined, notebook: IndexNotebook | undefined): string {
  return `${folder ? `${folder.name}/` : ""}${notebook ? `${notebook.title}/` : ""}`;
}

function startsWithCI(s: string, prefix: string): boolean {
  return s.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

/** Longest name + "/" that starts `text`; ties go to the first candidate. */
function longestPrefix<T>(cands: T[], name: (c: T) => string, text: string): T | undefined {
  let best: T | undefined;
  let len = -1;
  for (const c of cands) {
    const n = name(c);
    if (n.trim() && n.length > len && startsWithCI(text, `${n}/`)) {
      best = c;
      len = n.length;
    }
  }
  return best;
}

/**
 * Split the @ query into a scope ("Stats/" → that notebook or folder) and the
 * search text after it. A title that itself contains "/" still works: the
 * longest matching name wins. `hint` (the row the user picked) wins over names.
 */
export function parseScope(index: MentionIndex, query: string, hint?: ScopeHint | null): { scope: PickerScope | null; rest: string } {
  if (hint && hint.path && startsWithCI(query, hint.path)) {
    const folder = hint.folderId ? index.folders.find((f) => f.id === hint.folderId) : undefined;
    const notebook = hint.notebookId ? index.notebooks.find((n) => n.id === hint.notebookId) : undefined;
    if (folder || notebook) return { scope: { folder, notebook, path: hint.path }, rest: query.slice(hint.path.length) };
  }
  const byRecent = [...index.notebooks].sort((a, b) => b.updatedAt - a.updatedAt);
  const folder = longestPrefix(index.folders, (f) => f.name, query);
  const notebook = longestPrefix(byRecent, (n) => n.title, query);
  // A notebook and a folder with the same name: the folder (it can then show that notebook).
  if (folder && (!notebook || folder.name.length >= notebook.title.length)) {
    const after = query.slice(folder.name.length + 1);
    const inner = longestPrefix(byRecent.filter((n) => n.folderId === folder.id), (n) => n.title, after);
    const path = scopePath(folder, inner);
    return { scope: { folder, notebook: inner, path }, rest: query.slice(path.length) };
  }
  if (notebook) {
    const path = scopePath(undefined, notebook);
    return { scope: { notebook, path }, rest: query.slice(path.length) };
  }
  return { scope: null, rest: query };
}

/**
 * How well `title` matches the typed text (null = not at all): exact, then
 * prefix, then every word starting a word in the title, then every word
 * anywhere in it. An empty query matches everything equally.
 */
export function matchScore(title: string, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = title.toLowerCase();
  if (t === q) return 120;
  if (t.startsWith(q)) return 100;
  const words = q.split(/\s+/);
  if (!words.every((w) => t.includes(w))) return null;
  const atWordStart = words.every((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(w)}`, "u").test(t));
  return atWordStart ? 70 : 40;
}

const ROW_LIMIT = 12;
const SCOPED_LIMIT = 60;

/**
 * The @ menu's rows for `query`.
 *
 * - "@" alone: this notebook's items, then other notebooks (starred, then
 *   recent) and folders to open.
 * - "@prob": everything whose title matches, across every notebook. This
 *   notebook's items rank first, then items of starred and recently used
 *   notebooks; better title matches beat both.
 * - "@Stats 101/" or "@Courses/": inside that notebook or folder. A notebook
 *   other than this one offers "all of it" first.
 *
 * `local` is this notebook's own items, live from the panel (the index may be
 * a moment behind); the index's rows for it are ignored.
 */
export function pickerRows(
  index: MentionIndex,
  query: string,
  currentNotebookId: string,
  local: IndexItem[],
  hint?: ScopeHint | null
): { scope: PickerScope | null; rows: PickerRow[] } {
  const { scope, rest } = parseScope(index, query, hint);
  const nbById = new Map(index.notebooks.map((n) => [n.id, n]));
  const foreign = index.items.filter((i) => i.notebookId !== currentNotebookId && nbById.has(i.notebookId));
  const countIn = new Map<string, number>();
  for (const i of [...foreign, ...local]) countIn.set(i.notebookId, (countIn.get(i.notebookId) ?? 0) + 1);
  const notebooksIn = new Map<string, number>();
  for (const n of index.notebooks) notebooksIn.set(n.folderId, (notebooksIn.get(n.folderId) ?? 0) + 1);

  const recency = [...index.notebooks].sort((a, b) => b.updatedAt - a.updatedAt);
  const recentRank = new Map(recency.map((n, i) => [n.id, i]));
  /** 0–30: starred and recently used notebooks come first. */
  const nbBoost = (n: IndexNotebook) =>
    (n.starred ? 10 : 0) + 20 * (1 - (recentRank.get(n.id) ?? recency.length) / Math.max(1, recency.length));

  const itemRow = (item: IndexItem): PickerRow => ({
    kind: "item",
    key: `i:${item.id}`,
    item,
    notebook: item.notebookId === currentNotebookId ? undefined : nbById.get(item.notebookId),
  });
  const notebookRow = (n: IndexNotebook): PickerRow => ({ kind: "notebook", key: `n:${n.id}`, notebook: n, count: countIn.get(n.id) ?? 0 });
  const folderRow = (f: IndexFolder): PickerRow => ({ kind: "folder", key: `f:${f.id}`, folder: f, count: notebooksIn.get(f.id) ?? 0 });

  type Scored = { row: PickerRow; score: number; tie: number };
  const ranked = (cands: Scored[], limit: number) =>
    cands.sort((a, b) => b.score - a.score || b.tie - a.tie).slice(0, limit).map((c) => c.row);

  // Inside a notebook: its items (and "all of it" for another notebook).
  if (scope?.notebook) {
    const nb = scope.notebook;
    const items = nb.id === currentNotebookId ? local : foreign.filter((i) => i.notebookId === nb.id);
    const rows: PickerRow[] = [];
    if (nb.id !== currentNotebookId && !rest.trim()) rows.push({ kind: "whole", key: `w:${nb.id}`, notebook: nb, count: items.length });
    const cands: Scored[] = [];
    items.forEach((item, i) => {
      const m = matchScore(item.title, rest);
      if (m !== null) cands.push({ row: itemRow(item), score: m, tie: -i });
    });
    return { scope, rows: [...rows, ...ranked(cands, SCOPED_LIMIT)] };
  }

  // Inside a folder: its notebooks.
  if (scope?.folder) {
    const cands: Scored[] = [];
    for (const n of index.notebooks.filter((x) => x.folderId === scope.folder!.id)) {
      const m = matchScore(n.title, rest);
      if (m !== null) cands.push({ row: notebookRow(n), score: m + nbBoost(n), tie: n.updatedAt });
    }
    return { scope, rows: ranked(cands, SCOPED_LIMIT) };
  }

  const others = index.notebooks.filter((n) => n.id !== currentNotebookId);
  if (!rest.trim()) {
    const nbs = [...others].sort((a, b) => Number(b.starred) - Number(a.starred) || b.updatedAt - a.updatedAt);
    const folders = [...index.folders].sort((a, b) => a.name.localeCompare(b.name));
    return {
      scope: null,
      rows: [...local.slice(0, 6).map(itemRow), ...nbs.slice(0, 4).map(notebookRow), ...folders.slice(0, 3).map(folderRow)],
    };
  }

  const cands: Scored[] = [];
  local.forEach((item, i) => {
    const m = matchScore(item.title, rest);
    if (m !== null) cands.push({ row: itemRow(item), score: m + 50, tie: -i });
  });
  for (const item of foreign) {
    const m = matchScore(item.title, rest);
    if (m !== null) cands.push({ row: itemRow(item), score: m + nbBoost(nbById.get(item.notebookId)!), tie: item.createdAt });
  }
  for (const n of others) {
    const m = matchScore(n.title, rest);
    if (m !== null) cands.push({ row: notebookRow(n), score: m + nbBoost(n) + 5, tie: n.updatedAt });
  }
  for (const f of index.folders) {
    const m = matchScore(f.name, rest);
    if (m !== null) cands.push({ row: folderRow(f), score: m + 15, tie: 0 });
  }
  return { scope: null, rows: ranked(cands, ROW_LIMIT) };
}

/* ------------------------------ prompt budget ------------------------------ */

/**
 * Characters the @-mentioned material may use. Pulling in another notebook's
 * material is the point of the message, so it gets more room than an
 * in-notebook mention (whose notebook is usually in the prompt anyway): a
 * fifth of the sources budget, at most 40k characters (~11k tokens).
 */
export function mentionBudget(b: { mentions: number; sources: number }, items: MentionItem[]): number {
  const wide = items.some((m) => m.group === "notebook" || (m.notebookId && !m.missing));
  return wide ? Math.max(b.mentions, Math.min(Math.floor(b.sources * 0.2), 40_000)) : b.mentions;
}

/**
 * Split `total` across items that each want `needs[i]` characters, fairly:
 * small items get all they need, and what they leave goes to the larger ones
 * in equal shares. Never more than `total` in all.
 */
export function shareBudget(needs: number[], total: number): number[] {
  const out = needs.map(() => 0);
  const order = needs.map((n, i) => ({ n: Math.max(0, n), i })).sort((a, b) => a.n - b.n);
  let left = Math.max(0, total);
  order.forEach(({ n, i }, k) => {
    const share = Math.floor(left / (order.length - k));
    out[i] = Math.min(n, share);
    left -= out[i];
  });
  return out;
}

/** How the prompt describes a mentioned item, after its "@Title". */
export function mentionLabel(m: MentionItem): string {
  if (m.group === "notebook") {
    const what = m.excerpt ? "the parts most relevant to this message" : "everything readable in it";
    return `Your notebook "${m.title}" · ${what}`;
  }
  const kind = `${m.group === "source" ? "Source" : "Output"} · ${m.type}`;
  const from = m.notebookId ? ` · from your notebook "${m.notebookTitle ?? "another notebook"}"` : "";
  return `${kind}${from}${m.excerpt ? " · the parts most relevant to this message" : ""}`;
}
