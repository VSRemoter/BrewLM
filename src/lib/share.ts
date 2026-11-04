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
 * The same snapshot under fresh ids, every row pointing at `notebookId`.
 * Links between rows follow: chunks → sources, messages → chats, images →
 * chats and parent images, `brewimg:` references in messages and outputs.
 * A link to something outside the snapshot is cleared rather than left
 * pointing at another notebook's row.
 */
export function remapSnapshot(snap: NotebookSnapshot, notebookId: string, newId: () => string = uid): NotebookSnapshot {
  const ids = new Map<string, string>();
  const fresh = (old: string) => {
    let id = ids.get(old);
    if (!id) ids.set(old, (id = newId()));
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
      .map((c) => ({ ...c, id: newId(), source_id: fresh(c.source_id), notebook_id: notebookId })),
    artifacts: snap.artifacts.map((a) => ({ ...a, id: newId(), notebook_id: notebookId, data: relinkImages(a.data) })),
    chats: snap.chats.map((c) => ({ ...c, id: fresh(c.id), notebook_id: notebookId })),
    messages: snap.messages.map((m) => ({
      ...m,
      id: newId(),
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
  const d = await getDb();
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
        "INSERT INTO chats (id, notebook_id, title, pinned, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [c.id, c.notebook_id, c.title, c.pinned ?? 0, c.created_at, c.updated_at]
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
    await d.execute(
      "INSERT INTO notebooks (id, title, description, starred, cover, chat_bg, chat_bg_dim, folder_id, grounded, constitution_on, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
      [nb.id, nb.title, nb.description, nb.starred, nb.cover, nb.chat_bg, nb.chat_bg_dim, nb.folder_id, nb.grounded, nb.constitution_on, nb.created_at, nb.updated_at]
    );
  } catch (e) {
    for (const t of ["sources", "source_chunks", "artifacts", "chats", "images", "messages"])
      await d.execute(`DELETE FROM ${t} WHERE notebook_id = $1`, [nb.id]).catch(() => {});
    throw e;
  }
  return nb;
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
