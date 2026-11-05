/**
 * Notebook snapshots: one notebook's rows as a single portable object.
 *
 * "Duplicate" (/clone, Use as template) builds one and writes it straight
 * back; shared links (planned) will encrypt and upload one, and "Save a copy"
 * will write a downloaded one. Writing always gives every row a fresh id, so a
 * snapshot can be imported any number of times next to its original.
 *
 * What goes in: the notebook's shared look and behaviour (title, description,
 * cover, chat background, grounding, constitution toggle), sources, their
 * search chunks and embeddings (so the copy needs no re-indexing), Studio
 * outputs, and optionally chats with their messages and generated images.
 * Never included: per-person placement (folder, star, trash), reasoning
 * (it stays on the computer that made it), settings and keys.
 *
 * Media stay `brewblob:` references; the files themselves travel separately
 * (`snapshotBlobRefs` lists them).
 */
import { blobRefsIn } from "./blobs";
import { getDb, uid, type LibraryImage } from "./db";
import type { Artifact, Chat, ChatMessage, Notebook, Source, SourceChunk } from "./types";

export const SNAPSHOT_FORMAT = "brewlm-notebook";
export const SNAPSHOT_VERSION = 1;

export type SnapshotNotebook = Pick<
  Notebook,
  "title" | "description" | "cover" | "chat_bg" | "chat_bg_dim" | "grounded" | "constitution_on"
>;

export interface NotebookSnapshot {
  format: typeof SNAPSHOT_FORMAT;
  version: number;
  created_at: number;
  notebook: SnapshotNotebook;
  sources: Source[];
  chunks: SourceChunk[];
  artifacts: Artifact[];
  chats: Chat[];
  messages: ChatMessage[];
  images: LibraryImage[];
}

export interface SnapshotOptions {
  /** Studio outputs (default true). */
  includeArtifacts?: boolean;
  /** Chats, their messages and the images those messages show (default false). */
  includeChats?: boolean;
}

const IMAGE_REF_RE = /brewimg:([a-zA-Z0-9-]+)/g;

/** Image ids a message or output points at (`![alt](brewimg:<id>)`). */
function imageIdsIn(text: string): string[] {
  return text.includes("brewimg:") ? [...text.matchAll(IMAGE_REF_RE)].map((m) => m[1]) : [];
}

/** Read one notebook into a snapshot. */
export async function readSnapshot(notebookId: string, opts: SnapshotOptions = {}): Promise<NotebookSnapshot> {
  const d = await getDb();
  const [nb] = await d.select<Notebook[]>("SELECT * FROM notebooks WHERE id = $1", [notebookId]);
  if (!nb) throw new Error("Notebook not found");
  const sources = await d.select<Source[]>(
    "SELECT * FROM sources WHERE notebook_id = $1 ORDER BY created_at ASC",
    [notebookId]
  );
  const chunks = await d.select<SourceChunk[]>(
    "SELECT * FROM source_chunks WHERE notebook_id = $1 ORDER BY source_id, seq",
    [notebookId]
  );
  const artifacts =
    opts.includeArtifacts ?? true
      ? await d.select<Artifact[]>("SELECT * FROM artifacts WHERE notebook_id = $1 ORDER BY created_at ASC", [notebookId])
      : [];
  const chats = opts.includeChats
    ? await d.select<Chat[]>("SELECT * FROM chats WHERE notebook_id = $1 ORDER BY created_at ASC", [notebookId])
    : [];
  const messages = opts.includeChats
    ? await d.select<ChatMessage[]>("SELECT * FROM messages WHERE notebook_id = $1 ORDER BY created_at ASC", [notebookId])
    : [];

  // Images belong to the messages that show them (a clone's messages may point
  // at rows of the original notebook, so look them up by id, not notebook).
  const wanted = new Set([...messages, ...artifacts].flatMap((r) => imageIdsIn("content" in r ? r.content : r.data)));
  const images: LibraryImage[] = [];
  for (const id of wanted) {
    const [img] = await d.select<LibraryImage[]>("SELECT * FROM images WHERE id = $1", [id]);
    if (img) images.push(img);
  }

  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    created_at: Date.now(),
    notebook: {
      title: nb.title,
      description: nb.description,
      cover: nb.cover,
      chat_bg: nb.chat_bg,
      chat_bg_dim: nb.chat_bg_dim,
      grounded: nb.grounded ?? 1,
      constitution_on: nb.constitution_on ?? 1,
    },
    sources,
    // Chunks of sources that no longer exist would only be dead weight.
    chunks: chunks.filter((c) => sources.some((s) => s.id === c.source_id)),
    artifacts,
    chats,
    messages,
    images,
  };
}

/** Every media file a snapshot points at, once each. */
export function snapshotBlobRefs(snap: NotebookSnapshot): string[] {
  const texts = [
    snap.notebook.cover,
    snap.notebook.chat_bg,
    ...snap.sources.map((s) => s.content),
    ...snap.artifacts.map((a) => a.data),
    ...snap.images.map((i) => i.data),
  ];
  return [...new Set(texts.flatMap(blobRefsIn))];
}

/**
 * The same snapshot under fresh ids (`newId(oldId)`), every row pointing at `notebookId`.
 * Links between rows follow: chunks → sources, messages → chats, images →
 * chats and parent images, `brewimg:` references in messages and outputs.
 * A link to something outside the snapshot is cleared rather than left
 * pointing at another notebook's row.
 */
export function remapSnapshot(
  snap: NotebookSnapshot,
  notebookId: string,
  newId: (oldId: string) => string = () => uid()
): NotebookSnapshot {
  const ids = new Map<string, string>();
  const fresh = (old: string) => {
    let id = ids.get(old);
    if (!id) ids.set(old, (id = newId(old)));
    return id;
  };
  snap.sources.forEach((s) => fresh(s.id));
  snap.chats.forEach((c) => fresh(c.id));
  snap.images.forEach((i) => fresh(i.id));
  const known = (old: string | null | undefined) => (old ? ids.get(old) ?? null : null);
  const relinkImages = (text: string) =>
    text.includes("brewimg:") ? text.replace(IMAGE_REF_RE, (m, id: string) => (ids.has(id) ? `brewimg:${ids.get(id)}` : m)) : text;

  return {
    ...snap,
    sources: snap.sources.map((s) => ({ ...s, id: fresh(s.id), notebook_id: notebookId })),
    chunks: snap.chunks
      .filter((c) => ids.has(c.source_id))
      .map((c) => ({ ...c, id: newId(c.id), source_id: fresh(c.source_id), notebook_id: notebookId })),
    artifacts: snap.artifacts.map((a) => ({ ...a, id: newId(a.id), notebook_id: notebookId, data: relinkImages(a.data) })),
    chats: snap.chats.map((c) => ({ ...c, id: fresh(c.id), notebook_id: notebookId })),
    messages: snap.messages.map((m) => ({
      ...m,
      id: newId(m.id),
      notebook_id: notebookId,
      chat_id: known(m.chat_id),
      content: relinkImages(m.content),
    })),
    images: snap.images.map((i) => ({
      ...i,
      id: fresh(i.id),
      notebook_id: notebookId,
      chat_id: known(i.chat_id) ?? "",
      parent_id: known(i.parent_id) ?? "",
    })),
  };
}

export interface WriteOptions {
  title?: string;
  folderId?: string;
  starred?: number;
}

/**
 * Add a snapshot to the library as a new notebook; returns it. The notebook
 * row goes in last, so a failure part-way leaves nothing visible (and the
 * rows written so far are removed).
 */
export async function writeSnapshot(snap: NotebookSnapshot, opts: WriteOptions = {}): Promise<Notebook> {
  if (snap.format !== SNAPSHOT_FORMAT) throw new Error("Not a BrewLM notebook");
  if (snap.version > SNAPSHOT_VERSION) throw new Error("This notebook needs a newer version of BrewLM");
  const now = Date.now();
  const nb: Notebook = {
    ...snap.notebook,
    id: uid(),
    title: opts.title ?? snap.notebook.title,
    starred: opts.starred ?? 0,
    folder_id: opts.folderId ?? "",
    trashed_at: 0,
    created_at: now,
    updated_at: now,
  };
  const s = remapSnapshot(snap, nb.id);
  try {
    await insertRows(s);
    await insertNotebook(nb);
  } catch (e) {
    await deleteRows(nb.id);
    throw e;
  }
  return nb;
}

/** Insert a remapped snapshot's rows (`fromShare` marks its chats as the link's). */
async function insertRows(s: NotebookSnapshot, fromShare = false): Promise<void> {
  const d = await getDb();
  for (const r of s.sources) {
    await d.execute(
      "INSERT INTO sources (id, notebook_id, type, title, content, mime, pinned, text, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [r.id, r.notebook_id, r.type, r.title, r.content, r.mime, r.pinned ?? 0, r.text ?? "", r.created_at]
    );
  }
  for (const c of s.chunks) {
    await d.execute(
      "INSERT INTO source_chunks (id, source_id, notebook_id, seq, page, text, embedding) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [c.id, c.source_id, c.notebook_id, c.seq, c.page, c.text, c.embedding]
    );
  }
  for (const a of s.artifacts) {
    await d.execute(
      "INSERT INTO artifacts (id, notebook_id, kind, title, data, pinned, usage, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [a.id, a.notebook_id, a.kind, a.title, a.data, a.pinned ?? 0, a.usage ?? null, a.created_at]
    );
  }
  for (const c of s.chats) {
    await d.execute(
      "INSERT INTO chats (id, notebook_id, title, pinned, from_share, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [c.id, c.notebook_id, c.title, c.pinned ?? 0, fromShare ? 1 : 0, c.created_at, c.updated_at]
    );
  }
  for (const i of s.images) {
    await d.execute(
      "INSERT INTO images (id, notebook_id, chat_id, prompt, model, mime, data, width, height, parent_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
      [i.id, i.notebook_id, i.chat_id, i.prompt, i.model, i.mime, i.data, i.width, i.height, i.parent_id, i.created_at]
    );
  }
  for (const m of s.messages) {
    await d.execute(
      "INSERT INTO messages (id, notebook_id, chat_id, role, content, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [m.id, m.notebook_id, m.chat_id, m.role, m.content, m.created_at]
    );
  }
}

async function insertNotebook(nb: Notebook): Promise<void> {
  const d = await getDb();
  await d.execute(
    "INSERT INTO notebooks (id, title, description, starred, cover, chat_bg, chat_bg_dim, folder_id, grounded, constitution_on, share_id, share_key, share_version, shared_by, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)",
    [nb.id, nb.title, nb.description, nb.starred, nb.cover, nb.chat_bg, nb.chat_bg_dim, nb.folder_id, nb.grounded, nb.constitution_on, nb.share_id ?? "", nb.share_key ?? "", nb.share_version ?? 0, nb.shared_by ?? "", nb.created_at, nb.updated_at]
  );
}

/** Best-effort removal of a notebook's rows (a failed import's leftovers). */
async function deleteRows(notebookId: string): Promise<void> {
  const d = await getDb();
  for (const t of ["sources", "source_chunks", "artifacts", "chats", "images", "messages"])
    await d.execute(`DELETE FROM ${t} WHERE notebook_id = $1`, [notebookId]).catch(() => {});
}

/** Where a shared notebook came from. */
export interface ShareOrigin {
  id: string;
  key: string;
  version: number;
  sharedBy: string;
}

/** A row id for a link's row: the same every time that link is opened, so updates replace rows in place. */
async function stableIds(shareId: string, olds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const enc = new TextEncoder();
  for (const old of olds) {
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`brewlm-share:${shareId}:${old}`)));
    const x = [...h.subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
    out.set(old, `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`);
  }
  return out;
}

/**
 * Write a shared link's snapshot as a read-only notebook, or bring an earlier
 * copy of it up to date: its sources, outputs and the link's own chats are
 * replaced, and the viewer's chats stay (row ids are stable per link, so
 * whatever they point at still resolves). Returns the notebook's id.
 */
export async function writeSharedSnapshot(snap: NotebookSnapshot, origin: ShareOrigin): Promise<string> {
  if (snap.format !== SNAPSHOT_FORMAT) throw new Error("Not a BrewLM notebook");
  if (snap.version > SNAPSHOT_VERSION) throw new Error("This notebook needs a newer version of BrewLM");
  const olds = ["notebook", ...[snap.sources, snap.chunks, snap.artifacts, snap.chats, snap.messages, snap.images].flat().map((r) => r.id)];
  const ids = await stableIds(origin.id, olds);
  const nbId = ids.get("notebook")!;
  const s = remapSnapshot(snap, nbId, (old) => ids.get(old)!);
  const d = await getDb();
  const [existing] = await d.select<Notebook[]>("SELECT * FROM notebooks WHERE id = $1", [nbId]);
  const now = Date.now();
  await d.execute("INSERT INTO sync_state (key, value) VALUES ('share_writing', '1') ON CONFLICT(key) DO UPDATE SET value = '1'");
  try {
    if (existing) {
      const linkChats = "SELECT id FROM chats WHERE notebook_id = $1 AND from_share = 1";
      await d.execute(`DELETE FROM messages WHERE chat_id IN (${linkChats})`, [nbId]);
      await d.execute(`DELETE FROM images WHERE chat_id IN (${linkChats})`, [nbId]);
      await d.execute("DELETE FROM chats WHERE notebook_id = $1 AND from_share = 1", [nbId]);
      for (const t of ["source_chunks", "sources", "artifacts"]) await d.execute(`DELETE FROM ${t} WHERE notebook_id = $1`, [nbId]);
      await insertRows(s, true);
      const n = snap.notebook;
      // The version last: a failure part-way leaves it behind, so the update is offered again.
      await d.execute(
        "UPDATE notebooks SET title = $1, description = $2, cover = $3, chat_bg = $4, chat_bg_dim = $5, grounded = $6, constitution_on = $7, share_key = $8, shared_by = $9, share_version = $10, updated_at = $11 WHERE id = $12",
        [n.title, n.description, n.cover, n.chat_bg, n.chat_bg_dim, n.grounded, n.constitution_on, origin.key, origin.sharedBy, origin.version, now, nbId]
      );
    } else {
      try {
        await insertRows(s, true);
        await insertNotebook({
          ...snap.notebook,
          id: nbId,
          starred: 0,
          folder_id: "",
          trashed_at: 0,
          share_id: origin.id,
          share_key: origin.key,
          share_version: origin.version,
          shared_by: origin.sharedBy,
          created_at: now,
          updated_at: now,
        });
      } catch (e) {
        await deleteRows(nbId);
        throw e;
      }
    }
  } finally {
    await d.execute("UPDATE sync_state SET value = '0' WHERE key = 'share_writing'");
  }
  return nbId;
}

/**
 * Deep-copy a notebook: description/cover/star/folder + sources (with their
 * search index) always.
 * - includeArtifacts: studio outputs (flashcards, quizzes, audio, etc.)
 * - includeChats: chat threads, their messages and generated images
 * Full clone = both; "Use as template" = neither (sources-only starter copy).
 */
export async function cloneNotebook(
  srcId: string,
  title: string,
  opts: { includeChats: boolean; includeArtifacts?: boolean }
): Promise<Notebook> {
  const d = await getDb();
  const [src] = await d.select<Notebook[]>("SELECT * FROM notebooks WHERE id = $1", [srcId]);
  if (!src) throw new Error("Notebook not found");
  const snap = await readSnapshot(srcId, opts);
  return writeSnapshot(snap, { title, folderId: src.folder_id, starred: src.starred });
}
