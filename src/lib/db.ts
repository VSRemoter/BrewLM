import { platform, type SqlDb } from "../platform";
import { SYNCED_TABLES } from "./syncTables";
import { blobRefsIn, gcBlobs, isBlobRef, isMediaValue, storeArtifactMedia, storeMedia } from "./blobs";
import type { Artifact, ArtifactKind, Chat, ChatMessage, Folder, Notebook, Source, SourceChunk, SourceType } from "./types";

export function uid(): string {
  return crypto.randomUUID();
}

let dbPromise: Promise<SqlDb> | null = null;

/**
 * Serializes init: concurrent callers share ONE migration pass (two passes
 * would race on ALTERs — "duplicate column name").
 */
export async function getDb(): Promise<SqlDb> {
  return (dbPromise ??= initDb());
}

async function initDb(): Promise<SqlDb> {
  const db = await platform.openDb();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS notebooks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      mime TEXT,
      created_at INTEGER NOT NULL
    )`);
  // Retrieval index: chunked source text + optional embeddings (see rag.ts).
  await db.execute(`
    CREATE TABLE IF NOT EXISTS source_chunks (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      notebook_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      page INTEGER,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL DEFAULT ''
    )`);
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_source_chunks_notebook ON source_chunks(notebook_id)"
  );
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_source_chunks_source ON source_chunks(source_id)"
  );
  await db.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  // chat_sessions migration: messages gain chat_id; pre-existing threads
  // become a single "Chat 1" per notebook.
  const msgCols = await db.select<{ name: string }[]>("PRAGMA table_info(messages)");
  if (!msgCols.some((c) => c.name === "chat_id")) {
    await db.execute("ALTER TABLE messages ADD COLUMN chat_id TEXT");
    const owners = await db.select<{ notebook_id: string }[]>(
      "SELECT DISTINCT notebook_id FROM messages"
    );
    for (const { notebook_id } of owners) {
      const now = Date.now();
      const chatId = uid();
      await db.execute(
        "INSERT INTO chats (id, notebook_id, title, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)",
        [chatId, notebook_id, "Chat 1", now, now]
      );
      await db.execute(
        "UPDATE messages SET chat_id = $1 WHERE notebook_id = $2 AND chat_id IS NULL",
        [chatId, notebook_id]
      );
    }
  }
  await db.execute(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
  // Pinning: pinned sources/artifacts sort first (constitution still wins over pins).
  const srcCols = await db.select<{ name: string }[]>("PRAGMA table_info(sources)");
  if (!srcCols.some((c) => c.name === "pinned")) {
    await db.execute("ALTER TABLE sources ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  }
  // Media sources (image/audio) keep their data URL in `content`; `text` holds
  // what the model reads instead — an image description/OCR or a transcript.
  if (!srcCols.some((c) => c.name === "text")) {
    await db.execute("ALTER TABLE sources ADD COLUMN text TEXT NOT NULL DEFAULT ''");
  }
  const chatCols = await db.select<{ name: string }[]>("PRAGMA table_info(chats)");
  if (!chatCols.some((c) => c.name === "pinned")) {
    await db.execute("ALTER TABLE chats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  }
  const artCols = await db.select<{ name: string }[]>("PRAGMA table_info(artifacts)");
  if (!artCols.some((c) => c.name === "pinned")) {
    await db.execute("ALTER TABLE artifacts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  }
  await db.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
  // Phone sharing: paired devices, queued jobs (chat/generate), activity log.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL DEFAULT 'full',
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL DEFAULT 0,
      revoked_at INTEGER NOT NULL DEFAULT 0
    )`);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      notebook_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payload TEXT NOT NULL DEFAULT '{}',
      result TEXT NOT NULL DEFAULT '',
      progress TEXT NOT NULL DEFAULT '',
      device_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS activity (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    )`);
  // notebooks gain description (added after the initial schema).
  const nbCols = await db.select<{ name: string }[]>("PRAGMA table_info(notebooks)");
  if (!nbCols.some((c) => c.name === "description"))
    await db.execute("ALTER TABLE notebooks ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  // notebooks gain starred (homepage pinning).
  if (!nbCols.some((c) => c.name === "starred"))
    await db.execute("ALTER TABLE notebooks ADD COLUMN starred INTEGER NOT NULL DEFAULT 0");
  // notebooks gain cover (homepage card banner, data URL — grid view only).
  if (!nbCols.some((c) => c.name === "cover"))
    await db.execute("ALTER TABLE notebooks ADD COLUMN cover TEXT NOT NULL DEFAULT ''");
  // Homepage folders: notebooks belong to at most one folder ("" = root).
  await db.execute(`
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      cover TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    )`);
  if (!nbCols.some((c) => c.name === "folder_id"))
    await db.execute("ALTER TABLE notebooks ADD COLUMN folder_id TEXT NOT NULL DEFAULT ''");
  // notebooks gain trashed_at (homepage Trash: soft delete before permanent).
  if (!nbCols.some((c) => c.name === "trashed_at"))
    await db.execute("ALTER TABLE notebooks ADD COLUMN trashed_at INTEGER NOT NULL DEFAULT 0");
  // notebooks gain chat_bg (chat background image, data URL) + chat_bg_dim (dark overlay %).
  if (!nbCols.some((c) => c.name === "chat_bg"))
    await db.execute("ALTER TABLE notebooks ADD COLUMN chat_bg TEXT NOT NULL DEFAULT ''");
  if (!nbCols.some((c) => c.name === "chat_bg_dim"))
    await db.execute("ALTER TABLE notebooks ADD COLUMN chat_bg_dim INTEGER NOT NULL DEFAULT 55");
  // notebooks gain grounded (/ground toggle: 1 = answers grounded in sources).
  if (!nbCols.some((c) => c.name === "grounded"))
    await db.execute("ALTER TABLE notebooks ADD COLUMN grounded INTEGER NOT NULL DEFAULT 1");
  // notebooks gain constitution_on (/constitution toggle: 0 = keep it but ignore it).
  if (!nbCols.some((c) => c.name === "constitution_on"))
    await db.execute("ALTER TABLE notebooks ADD COLUMN constitution_on INTEGER NOT NULL DEFAULT 1");
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_sources_nb ON sources(notebook_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_messages_nb ON messages(notebook_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_chats_nb ON chats(notebook_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_artifacts_nb ON artifacts(notebook_id)`);
  // Token usage ledger powering Settings → Usage & Cost. cost_usd is the real
  // billed amount when the provider reports it (OpenRouter), NULL otherwise.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      kind TEXT NOT NULL,
      input INTEGER NOT NULL DEFAULT 0,
      output INTEGER NOT NULL DEFAULT 0,
      cached_read INTEGER NOT NULL DEFAULT 0,
      cached_write INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL
    )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts)`);
  // Generated-image library. Chat messages reference rows here as
  // `![alt](brewimg:<id>)` instead of embedding megabytes of base64, so chat
  // rows stay small and past images never leak into LLM context. `data` is
  // raw base64 (no data: prefix).
  await db.execute(`
    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL,
      chat_id TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      mime TEXT NOT NULL,
      data TEXT NOT NULL,
      width INTEGER NOT NULL DEFAULT 0,
      height INTEGER NOT NULL DEFAULT 0,
      parent_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    )`);
  await ensureSyncTracking(db);
  return db;
}

/* ------------------------- Sync change tracking ------------------------- */

export { SYNCED_TABLES };

const NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

/**
 * Change tracking for BrewLM Sync. Nothing uploads yet; this records which
 * rows changed and when, so the sync engine can push them later. Triggers
 * live in the database itself, so writes from the Rust phone server are
 * tracked too. Embeddings, devices, jobs and activity are local and untracked.
 *
 * - sync_meta: one row per synced row — last change time, a deleted flag
 *   (the tombstone other devices need to learn about deletes) and the HLC
 *   version it was last synced at ("" = never synced).
 * - sync_outbox: rows changed since the last push, one entry per row.
 * - sync_state: this device's id; `applying` = '1' silences the triggers
 *   while changes pulled from other devices are written.
 */
async function ensureSyncTracking(db: SqlDb): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS sync_meta (
      tbl TEXT NOT NULL,
      row_id TEXT NOT NULL,
      changed_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tbl, row_id)
    ) WITHOUT ROWID`);
  const metaCols = await db.select<{ name: string }[]>("PRAGMA table_info(sync_meta)");
  if (!metaCols.some((c) => c.name === "hlc"))
    await db.execute("ALTER TABLE sync_meta ADD COLUMN hlc TEXT NOT NULL DEFAULT ''");
  await db.execute(`
    CREATE TABLE IF NOT EXISTS sync_outbox (
      tbl TEXT NOT NULL,
      row_id TEXT NOT NULL,
      changed_at INTEGER NOT NULL,
      PRIMARY KEY (tbl, row_id)
    ) WITHOUT ROWID`);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
  await db.execute("INSERT OR IGNORE INTO sync_state (key, value) VALUES ('device_id', $1)", [uid()]);
  // Rows too big for the change log are uploaded as a file of their own: which
  // file each one's current server record uses, so a storage sweep keeps it.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS sync_record_blobs (
      tbl TEXT NOT NULL,
      row_id TEXT NOT NULL,
      blob TEXT NOT NULL,
      PRIMARY KEY (tbl, row_id)
    ) WITHOUT ROWID`);

  const quiet = "NOT EXISTS (SELECT 1 FROM sync_state WHERE key = 'applying' AND value = '1')";
  for (const [table, pk] of Object.entries(SYNCED_TABLES)) {
    for (const [op, ref, deleted] of [
      ["INSERT", "NEW", 0],
      ["UPDATE", "NEW", 0],
      ["DELETE", "OLD", 1],
    ] as const) {
      await db.execute(`
        CREATE TRIGGER IF NOT EXISTS sync_${table}_${op.toLowerCase()} AFTER ${op} ON ${table}
        WHEN ${quiet}
        BEGIN
          INSERT INTO sync_meta (tbl, row_id, changed_at, deleted)
            VALUES ('${table}', ${ref}.${pk}, ${NOW_MS}, ${deleted})
            ON CONFLICT (tbl, row_id) DO UPDATE SET changed_at = excluded.changed_at, deleted = excluded.deleted;
          INSERT INTO sync_outbox (tbl, row_id, changed_at)
            VALUES ('${table}', ${ref}.${pk}, ${NOW_MS})
            ON CONFLICT (tbl, row_id) DO UPDATE SET changed_at = excluded.changed_at;
        END`);
    }
  }

  // Rows that existed before tracking: recorded once, at time 0 — "older than
  // any edit" — so when this device joins a vault, the vault's copy of a row wins.
  const done = await db.select<{ value: string }[]>("SELECT value FROM sync_state WHERE key = 'backfilled'");
  if (done.length === 0) {
    for (const [table, pk] of Object.entries(SYNCED_TABLES)) {
      await db.execute(`INSERT OR IGNORE INTO sync_meta (tbl, row_id, changed_at, deleted) SELECT '${table}', ${pk}, 0, 0 FROM ${table}`);
      await db.execute(`INSERT OR IGNORE INTO sync_outbox (tbl, row_id, changed_at) SELECT '${table}', ${pk}, 0 FROM ${table}`);
    }
    await db.execute("INSERT INTO sync_state (key, value) VALUES ('backfilled', '1')");
  }
}

/* ------------------------------ Notebooks ------------------------------ */

export async function listNotebooks(): Promise<Notebook[]> {
  const d = await getDb();
  return d.select<Notebook[]>(
    "SELECT * FROM notebooks WHERE trashed_at = 0 ORDER BY updated_at DESC"
  );
}

/** Trash contents: soft-deleted notebooks, most recently trashed first. */
export async function listTrashedNotebooks(): Promise<Notebook[]> {
  const d = await getDb();
  return d.select<Notebook[]>(
    "SELECT * FROM notebooks WHERE trashed_at > 0 ORDER BY trashed_at DESC"
  );
}

/** Soft delete: moves the notebook to the Trash (restorable). */
export async function trashNotebook(id: string): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE notebooks SET trashed_at = $1 WHERE id = $2", [Date.now(), id]);
}

/** Recycle out of the Trash, back to where it was. */
export async function restoreNotebook(id: string): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE notebooks SET trashed_at = 0 WHERE id = $1", [id]);
}

export async function createNotebook(
  title: string,
  description = "",
  folderId = ""
): Promise<Notebook> {
  const d = await getDb();
  const now = Date.now();
  const nb: Notebook = {
    id: uid(),
    title,
    description,
    starred: 0,
    cover: "",
    chat_bg: "",
    chat_bg_dim: 55,
    folder_id: folderId,
    trashed_at: 0,
    grounded: 1,
    constitution_on: 1,
    created_at: now,
    updated_at: now,
  };
  await d.execute(
    "INSERT INTO notebooks (id, title, description, folder_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [nb.id, nb.title, nb.description, nb.folder_id, nb.created_at, nb.updated_at]
  );
  // Constitutions are opt-in: added via the sources "+" menu inside the notebook.
  return nb;
}

export async function renameNotebook(id: string, title: string): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE notebooks SET title = $1, updated_at = $2 WHERE id = $3", [
    title,
    Date.now(),
    id,
  ]);
}

/**
 * Deep-copy a notebook: description/cover/star/folder + sources always.
 * - includeArtifacts: studio outputs (flashcards, quizzes, audio, etc.)
 * - includeChats: chat threads and their messages
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
  const now = Date.now();
  const nb: Notebook = {
    id: uid(),
    title,
    description: src.description,
    starred: src.starred,
    cover: src.cover,
    chat_bg: src.chat_bg,
    chat_bg_dim: src.chat_bg_dim,
    folder_id: src.folder_id,
    trashed_at: 0,
    grounded: src.grounded ?? 1,
    constitution_on: src.constitution_on ?? 1,
    created_at: now,
    updated_at: now,
  };
  await d.execute(
    "INSERT INTO notebooks (id, title, description, starred, cover, chat_bg, chat_bg_dim, folder_id, grounded, constitution_on, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
    [nb.id, nb.title, nb.description, nb.starred, nb.cover, nb.chat_bg, nb.chat_bg_dim, nb.folder_id, nb.grounded, nb.constitution_on, nb.created_at, nb.updated_at]
  );

  for (const s of await listSources(srcId)) {
    await d.execute(
      "INSERT INTO sources (id, notebook_id, type, title, content, mime, pinned, text, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [uid(), nb.id, s.type, s.title, s.content, s.mime, s.pinned ?? 0, s.text ?? "", now]
    );
  }
  if (opts.includeArtifacts ?? true) {
    for (const a of await d.select<Artifact[]>(
      "SELECT * FROM artifacts WHERE notebook_id = $1",
      [srcId]
    )) {
      await d.execute(
        "INSERT INTO artifacts (id, notebook_id, kind, title, data, pinned, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [uid(), nb.id, a.kind, a.title, a.data, a.pinned ?? 0, now]
      );
    }
  }
  if (opts.includeChats) {
    const chatIdMap = new Map<string, string>();
    for (const c of await listChats(srcId)) {
      const newId = uid();
      chatIdMap.set(c.id, newId);
      await d.execute(
        "INSERT INTO chats (id, notebook_id, title, pinned, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [newId, nb.id, c.title, c.pinned ?? 0, c.created_at, c.updated_at]
      );
    }
    for (const m of await d.select<ChatMessage[]>(
      "SELECT * FROM messages WHERE notebook_id = $1",
      [srcId]
    )) {
      await d.execute(
        "INSERT INTO messages (id, notebook_id, chat_id, role, content, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [uid(), nb.id, m.chat_id ? chatIdMap.get(m.chat_id) ?? null : null, m.role, m.content, m.created_at]
      );
    }
  }
  return nb;
}

/** Edit title and description together (homepage edit modal). */
export async function updateNotebookDetails(
  id: string,
  title: string,
  description: string
): Promise<void> {
  const d = await getDb();
  await d.execute(
    "UPDATE notebooks SET title = $1, description = $2, updated_at = $3 WHERE id = $4",
    [title, description, Date.now(), id]
  );
}

/** Starring only pins — it must not bump updated_at (date sorting uses it). */
export async function setNotebookStarred(id: string, starred: boolean): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE notebooks SET starred = $1 WHERE id = $2", [starred ? 1 : 0, id]);
}

export async function setNotebookGrounded(id: string, grounded: boolean): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE notebooks SET grounded = $1 WHERE id = $2", [grounded ? 1 : 0, id]);
}

/** /ground flag (default 1 for legacy rows); used by the mobile job runner. */
export async function getNotebookGrounded(id: string): Promise<number> {
  const d = await getDb();
  const rows = await d.select<{ grounded: number }[]>(
    "SELECT grounded FROM notebooks WHERE id = $1",
    [id]
  );
  return rows[0]?.grounded ?? 1;
}

export async function setNotebookConstitutionOn(id: string, on: boolean): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE notebooks SET constitution_on = $1 WHERE id = $2", [on ? 1 : 0, id]);
}

/** /constitution flag (default 1 for legacy rows); used by the mobile job runner. */
export async function getNotebookConstitutionOn(id: string): Promise<number> {
  const d = await getDb();
  const rows = await d.select<{ constitution_on: number }[]>(
    "SELECT constitution_on FROM notebooks WHERE id = $1",
    [id]
  );
  return rows[0]?.constitution_on ?? 1;
}

/** Cover images are cosmetic — like starring, they must not bump updated_at. */
export async function setNotebookCover(id: string, cover: string): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE notebooks SET cover = $1 WHERE id = $2", [await storeMedia(cover), id]);
}

/** Set (or clear with "") the chat background image (JPEG data URL or stored file). */
export async function setNotebookChatBg(id: string, bg: string): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE notebooks SET chat_bg = $1 WHERE id = $2", [await storeMedia(bg), id]);
}

/** Readability overlay strength (0–80, percent of dark scrim over the chat background). */
export async function setNotebookChatBgDim(id: string, dim: number): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE notebooks SET chat_bg_dim = $1 WHERE id = $2", [
    Math.round(Math.max(0, Math.min(80, dim))),
    id,
  ]);
}

/** Moving a notebook between folders is organizational — don't bump updated_at. */
export async function moveNotebookToFolder(id: string, folderId: string): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE notebooks SET folder_id = $1 WHERE id = $2", [folderId, id]);
}

export async function touchNotebook(id: string): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE notebooks SET updated_at = $1 WHERE id = $2", [Date.now(), id]);
}

export async function deleteNotebook(id: string): Promise<void> {
  const d = await getDb();
  await d.execute("DELETE FROM sources WHERE notebook_id = $1", [id]);
  await d.execute("DELETE FROM source_chunks WHERE notebook_id = $1", [id]);
  await d.execute("DELETE FROM messages WHERE notebook_id = $1", [id]);
  await d.execute("DELETE FROM chats WHERE notebook_id = $1", [id]);
  await d.execute("DELETE FROM artifacts WHERE notebook_id = $1", [id]);
  await d.execute("DELETE FROM notebooks WHERE id = $1", [id]);
  await pruneOrphanImages();
}

/**
 * Trash auto-empty: permanently delete notebooks trashed longer than `days`
 * ago. 0 or negative = retention disabled. Runs once at startup; returns the
 * number of notebooks purged.
 */
export async function purgeExpiredTrash(days: number): Promise<number> {
  // Also sweeps images orphaned by deletions made outside this module (phone).
  await pruneOrphanImages();
  if (days <= 0) return 0;
  const cutoff = Date.now() - days * 86_400_000;
  const d = await getDb();
  const rows = await d.select<{ id: string }[]>(
    "SELECT id FROM notebooks WHERE trashed_at > 0 AND trashed_at < $1",
    [cutoff]
  );
  for (const r of rows) await deleteNotebook(r.id);
  return rows.length;
}

/* ------------------------------- Folders ------------------------------- */

export async function listFolders(): Promise<Folder[]> {
  const d = await getDb();
  return d.select<Folder[]>("SELECT * FROM folders ORDER BY created_at ASC");
}

export async function createFolder(name: string, description = ""): Promise<Folder> {
  const d = await getDb();
  const folder: Folder = { id: uid(), name, description, cover: "", created_at: Date.now() };
  await d.execute(
    "INSERT INTO folders (id, name, description, cover, created_at) VALUES ($1, $2, $3, $4, $5)",
    [folder.id, folder.name, folder.description, folder.cover, folder.created_at]
  );
  return folder;
}

/** Rename/redescribe a folder. Purely organizational — touches no timestamps anywhere. */
export async function updateFolderDetails(
  id: string,
  name: string,
  description: string
): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE folders SET name = $1, description = $2 WHERE id = $3", [
    name,
    description,
    id,
  ]);
}

export async function setFolderCover(id: string, cover: string): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE folders SET cover = $1 WHERE id = $2", [await storeMedia(cover), id]);
}

/** Deleting a folder never deletes notebooks — they return to the homepage root. */
export async function deleteFolder(id: string): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE notebooks SET folder_id = '' WHERE folder_id = $1", [id]);
  await d.execute("DELETE FROM folders WHERE id = $1", [id]);
}

/**
 * Resolve a folder by display name for the /move chat command:
 * case-insensitive exact match first, then a unique prefix match.
 * Returns "ambiguous" with the candidates when a prefix matches several.
 */
export async function findFolderByName(
  name: string
): Promise<{ status: "found"; folder: Folder } | { status: "none" } | { status: "ambiguous"; matches: Folder[] }> {
  const folders = await listFolders();
  const q = name.trim().toLowerCase();
  if (!q) return { status: "none" };
  const exact = folders.find((f) => f.name.toLowerCase() === q);
  if (exact) return { status: "found", folder: exact };
  const prefix = folders.filter((f) => f.name.toLowerCase().startsWith(q));
  if (prefix.length === 1) return { status: "found", folder: prefix[0] };
  if (prefix.length > 1) return { status: "ambiguous", matches: prefix };
  return { status: "none" };
}

/* ------------------------------- Sources ------------------------------- */

export async function listSources(notebookId: string): Promise<Source[]> {
  const d = await getDb();
  return d.select<Source[]>(
    "SELECT * FROM sources WHERE notebook_id = $1 ORDER BY created_at ASC",
    [notebookId]
  );
}

export async function addSource(
  notebookId: string,
  type: SourceType,
  title: string,
  content: string,
  mime: string | null = null,
  text = ""
): Promise<Source> {
  const d = await getDb();
  const src: Source = {
    id: uid(),
    notebook_id: notebookId,
    type,
    title,
    // Image/audio uploads go to the media store; the row keeps a reference.
    content: await storeMedia(content),
    mime,
    text,
    pinned: 0,
    created_at: Date.now(),
  };
  await d.execute(
    "INSERT INTO sources (id, notebook_id, type, title, content, mime, text, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [src.id, src.notebook_id, src.type, src.title, src.content, src.mime, src.text, src.created_at]
  );
  await touchNotebook(notebookId);
  return src;
}

export async function updateSource(
  id: string,
  title: string,
  content: string
): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE sources SET title = $1, content = $2 WHERE id = $3", [
    title,
    await storeMedia(content),
    id,
  ]);
  // Edited content invalidates its retrieval chunks (re-indexed lazily).
  await d.execute("DELETE FROM source_chunks WHERE source_id = $1", [id]);
}

/** Store the model-readable text of a media source (and drop stale chunks). */
export async function setSourceText(id: string, text: string): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE sources SET text = $1 WHERE id = $2", [text, id]);
  await d.execute("DELETE FROM source_chunks WHERE source_id = $1", [id]);
}

/**
 * The text the model reads for a source. Text sources are their content;
 * image/audio sources hold their file there (a stored-file reference, a data
 * URL, or a too-large placeholder), so their description/transcript lives in
 * `text` ("" = not extracted yet).
 */
export function sourceText(s: Source): string {
  if (s.type === "image" || s.type === "audio" || isMediaValue(s.content)) return s.text ?? "";
  return s.content;
}

/**
 * Repair sources saved by older versions that read Office/ePub files as plain
 * text, storing their raw zip bytes — megabytes of garbage the AI would read.
 * The original bytes can't be recovered (they were decoded as text), so the
 * content becomes a note asking the user to add the file again. Current
 * ingestion rejects binaries, so this only ever finds old rows.
 */
export async function repairBinarySources(): Promise<number> {
  const d = await getDb();
  // Zip and legacy Office files always contain NUL bytes; real text never does.
  const bad = "type IN ('text', 'file') AND instr(CAST(content AS BLOB), x'00') > 0";
  await d.execute(`DELETE FROM source_chunks WHERE source_id IN (SELECT id FROM sources WHERE ${bad})`);
  const res = await d.execute(
    `UPDATE sources SET content = 'Could not read ' || title || ' when it was added (an older BrewLM version saved the raw file instead of its text). Remove this source and add the file again.' WHERE ${bad}`
  );
  return res.rowsAffected;
}

export async function setSourcePinned(id: string, pinned: boolean): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE sources SET pinned = $1 WHERE id = $2", [pinned ? 1 : 0, id]);
}

export async function deleteSource(id: string): Promise<void> {
  const d = await getDb();
  await d.execute("DELETE FROM sources WHERE id = $1", [id]);
  await d.execute("DELETE FROM source_chunks WHERE source_id = $1", [id]);
}

/* ---------------------------- Source chunks (RAG) ---------------------------- */

/** Replace a source's whole chunk set (re-index). Pass [] to just clear it. */
export async function replaceChunks(chunks: SourceChunk[]): Promise<void> {
  if (chunks.length === 0) return;
  const d = await getDb();
  await d.execute("DELETE FROM source_chunks WHERE source_id = $1", [chunks[0].source_id]);
  for (const c of chunks) {
    await d.execute(
      "INSERT INTO source_chunks (id, source_id, notebook_id, seq, page, text, embedding) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [c.id, c.source_id, c.notebook_id, c.seq, c.page, c.text, c.embedding]
    );
  }
}

export async function chunksForNotebook(notebookId: string): Promise<SourceChunk[]> {
  const d = await getDb();
  return d.select<SourceChunk[]>(
    "SELECT * FROM source_chunks WHERE notebook_id = $1 ORDER BY source_id, seq",
    [notebookId]
  );
}

export async function chunksForSource(sourceId: string): Promise<SourceChunk[]> {
  const d = await getDb();
  return d.select<SourceChunk[]>(
    "SELECT * FROM source_chunks WHERE source_id = $1 ORDER BY seq",
    [sourceId]
  );
}

/** Source ids in this notebook that already have chunks (index-coverage check). */
export async function indexedSourceIds(notebookId: string): Promise<Set<string>> {
  const d = await getDb();
  const rows = await d.select<{ source_id: string }[]>(
    "SELECT DISTINCT source_id FROM source_chunks WHERE notebook_id = $1",
    [notebookId]
  );
  return new Set(rows.map((r) => r.source_id));
}

/** Source ids whose chunks are BM25-only (no embeddings stored — stale index). */
export async function unembeddedSourceIds(notebookId: string): Promise<Set<string>> {
  const d = await getDb();
  const rows = await d.select<{ source_id: string }[]>(
    "SELECT DISTINCT source_id FROM source_chunks WHERE notebook_id = $1 AND embedding = ''",
    [notebookId]
  );
  return new Set(rows.map((r) => r.source_id));
}

/* ------------------------------- Messages ------------------------------ */

export async function listMessages(chatId: string): Promise<ChatMessage[]> {
  const d = await getDb();
  return d.select<ChatMessage[]>(
    "SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at ASC",
    [chatId]
  );
}

export async function addMessage(
  chatId: string,
  notebookId: string,
  role: "user" | "assistant",
  content: string
): Promise<ChatMessage> {
  const d = await getDb();
  const msg: ChatMessage = {
    id: uid(),
    notebook_id: notebookId,
    chat_id: chatId,
    role,
    content,
    created_at: Date.now(),
  };
  await d.execute(
    "INSERT INTO messages (id, notebook_id, chat_id, role, content, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [msg.id, msg.notebook_id, msg.chat_id, msg.role, msg.content, msg.created_at]
  );
  await touchChat(chatId);
  await touchNotebook(notebookId);
  return msg;
}

/* ---------------------------- Image library ---------------------------- */

export interface LibraryImage {
  id: string;
  notebook_id: string;
  chat_id: string;
  prompt: string;
  model: string;
  mime: string;
  /** A `brewblob:` file reference (older rows: raw base64, no data: prefix). */
  data: string;
  width: number;
  height: number;
  parent_id: string;
  created_at: number;
}

export async function addImage(img: Omit<LibraryImage, "id" | "created_at">): Promise<string> {
  const d = await getDb();
  const id = uid();
  // Pixels go to the media store; raw base64 stays only if that fails.
  const stored = await storeMedia(`data:${img.mime};base64,${img.data}`);
  const data = isBlobRef(stored) ? stored : img.data;
  await d.execute(
    "INSERT INTO images (id, notebook_id, chat_id, prompt, model, mime, data, width, height, parent_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
    [id, img.notebook_id, img.chat_id, img.prompt, img.model, img.mime, data, img.width, img.height, img.parent_id, Date.now()]
  );
  return id;
}

export async function getImage(id: string): Promise<LibraryImage | null> {
  const d = await getDb();
  const rows = await d.select<LibraryImage[]>("SELECT * FROM images WHERE id = $1", [id]);
  return rows[0] ?? null;
}

/**
 * Drop images no message references any more. Messages are the only owners
 * (clones share image rows by reference), so this is the single cleanup path.
 */
export async function pruneOrphanImages(): Promise<void> {
  const d = await getDb();
  // Grace period: an image is saved a moment before the message that cites it.
  await d.execute(
    "DELETE FROM images WHERE created_at < $1 AND NOT EXISTS (SELECT 1 FROM messages m WHERE instr(m.content, 'brewimg:' || images.id) > 0)",
    [Date.now() - 10 * 60_000]
  );
}

/**
 * Delete media files no row references any more (deleted sources, replaced
 * covers, purged notebooks). Files written in the last 10 minutes are kept —
 * a file is saved a moment before the row that points at it.
 */
export async function pruneOrphanBlobs(): Promise<void> {
  const res = await gcBlobs(await referencedBlobRefs());
  if (res.removed > 0)
    console.info(`media: removed ${res.removed} unused file(s), ${(res.freed_bytes / 1e6).toFixed(1)} MB`);
}

/** Every `brewblob:` reference any row holds (cleanup keeps these; Sync moves them). */
export async function referencedBlobRefs(): Promise<string[]> {
  const d = await getDb();
  const has = (col: string) => `instr(${col}, 'brewblob:') > 0`;
  const rows = await d.select<{ v: string }[]>(
    `SELECT cover AS v FROM notebooks WHERE ${has("cover")}
     UNION ALL SELECT chat_bg FROM notebooks WHERE ${has("chat_bg")}
     UNION ALL SELECT cover FROM folders WHERE ${has("cover")}
     UNION ALL SELECT content FROM sources WHERE ${has("content")}
     UNION ALL SELECT data FROM images WHERE ${has("data")}
     UNION ALL SELECT data FROM artifacts WHERE ${has("data")}
     UNION ALL SELECT content FROM messages WHERE ${has("content")}`
  );
  return [...new Set(rows.flatMap((r) => blobRefsIn(r.v)))];
}

/* --------------------------------- Chats ------------------------------- */

export async function listChats(notebookId: string): Promise<Chat[]> {
  const d = await getDb();
  return d.select<Chat[]>(
    "SELECT * FROM chats WHERE notebook_id = $1 ORDER BY updated_at DESC",
    [notebookId]
  );
}

export async function createChat(notebookId: string, title = "New chat"): Promise<Chat> {
  const d = await getDb();
  const now = Date.now();
  const chat: Chat = {
    id: uid(),
    notebook_id: notebookId,
    title,
    created_at: now,
    updated_at: now,
    pinned: 0,
  };
  await d.execute(
    "INSERT INTO chats (id, notebook_id, title, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)",
    [chat.id, chat.notebook_id, chat.title, chat.created_at, chat.updated_at]
  );
  await touchNotebook(notebookId);
  return chat;
}

/**
 * Guarantee the notebook has at least one chat, creating the default one only
 * when none exists. The conditional INSERT is a single statement — atomic in
 * SQLite — so concurrent callers (React StrictMode's dev double-mount, fast
 * navigation) can't create duplicates the way check-then-create can.
 */
export async function ensureChat(notebookId: string): Promise<Chat> {
  const d = await getDb();
  const now = Date.now();
  const res = await d.execute(
    `INSERT INTO chats (id, notebook_id, title, created_at, updated_at)
     SELECT $1, $2, 'New chat', $3, $3
     WHERE NOT EXISTS (SELECT 1 FROM chats WHERE notebook_id = $2)`,
    [uid(), notebookId, now]
  );
  if (res.rowsAffected > 0) await touchNotebook(notebookId);
  const list = await listChats(notebookId);
  return list[0];
}

export async function renameChat(id: string, title: string): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE chats SET title = $1 WHERE id = $2", [title, id]);
}

/** Pinning is organizational — like starring, it must not bump updated_at. */
export async function setChatPinned(id: string, pinned: boolean): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE chats SET pinned = $1 WHERE id = $2", [pinned ? 1 : 0, id]);
}

export async function touchChat(id: string): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE chats SET updated_at = $1 WHERE id = $2", [Date.now(), id]);
}

export async function deleteChat(id: string): Promise<void> {
  const d = await getDb();
  await d.execute("DELETE FROM messages WHERE chat_id = $1", [id]);
  await d.execute("DELETE FROM chats WHERE id = $1", [id]);
  await pruneOrphanImages();
}

/* ------------------------------ Artifacts ------------------------------ */

/** One artifact as currently saved (null if it was deleted). */
export async function getArtifact(id: string): Promise<Artifact | null> {
  const d = await getDb();
  const rows = await d.select<Artifact[]>("SELECT * FROM artifacts WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function listArtifacts(notebookId: string): Promise<Artifact[]> {
  const d = await getDb();
  return d.select<Artifact[]>(
    "SELECT * FROM artifacts WHERE notebook_id = $1 ORDER BY created_at DESC",
    [notebookId]
  );
}

export async function addArtifact(
  notebookId: string,
  kind: ArtifactKind,
  title: string,
  data: string
): Promise<Artifact> {
  const d = await getDb();
  const art: Artifact = {
    id: uid(),
    notebook_id: notebookId,
    kind,
    title,
    // Audio overviews: the sound file goes to the media store.
    data: await storeArtifactMedia(data),
    pinned: 0,
    created_at: Date.now(),
  };
  await d.execute(
    "INSERT INTO artifacts (id, notebook_id, kind, title, data, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [art.id, art.notebook_id, art.kind, art.title, art.data, art.created_at]
  );
  return art;
}

export async function deleteArtifact(id: string): Promise<void> {
  const d = await getDb();
  await d.execute("DELETE FROM artifacts WHERE id = $1", [id]);
}

/** Remove a generated image from the library (its chat message then shows it as removed). */
export async function deleteImage(id: string): Promise<void> {
  const d = await getDb();
  await d.execute("DELETE FROM images WHERE id = $1", [id]);
}

export async function setArtifactPinned(id: string, pinned: boolean): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE artifacts SET pinned = $1 WHERE id = $2", [pinned ? 1 : 0, id]);
}

/** Rewrite an artifact's payload in place (Studio "Revise" → Replace original). */
export async function updateArtifact(id: string, data: string): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE artifacts SET data = $1 WHERE id = $2", [await storeArtifactMedia(data), id]);
}

/** Rename an artifact in place (Studio "Revise" modal title field — saved on the fly). */
export async function renameArtifact(id: string, title: string): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE artifacts SET title = $1 WHERE id = $2", [title, id]);
}

/* ------------------------------ Bulk delete (/remove) ------------------------------ */

/** All of a notebook's sources, optionally one type. Returns rows removed. */
export async function deleteSources(notebookId: string, type?: SourceType): Promise<number> {
  const d = await getDb();
  const res = type
    ? await d.execute("DELETE FROM sources WHERE notebook_id = $1 AND type = $2", [notebookId, type])
    : await d.execute("DELETE FROM sources WHERE notebook_id = $1", [notebookId]);
  if (res.rowsAffected > 0) {
    // Chunks of removed sources re-index on demand; clear per-type wipes wholesale.
    await d.execute(
      "DELETE FROM source_chunks WHERE notebook_id = $1 AND source_id NOT IN (SELECT id FROM sources WHERE notebook_id = $1)",
      [notebookId]
    );
  }
  return res.rowsAffected;
}

/** Every chat thread + message of a notebook. Returns threads removed. */
export async function deleteAllChats(notebookId: string): Promise<number> {
  const d = await getDb();
  await d.execute("DELETE FROM messages WHERE notebook_id = $1", [notebookId]);
  const res = await d.execute("DELETE FROM chats WHERE notebook_id = $1", [notebookId]);
  await pruneOrphanImages();
  return res.rowsAffected;
}

/** All studio outputs, optionally one kind (flashcards, quiz, audio…). Returns rows removed. */
export async function deleteArtifacts(notebookId: string, kind?: ArtifactKind): Promise<number> {
  const d = await getDb();
  const res = kind
    ? await d.execute("DELETE FROM artifacts WHERE notebook_id = $1 AND kind = $2", [notebookId, kind])
    : await d.execute("DELETE FROM artifacts WHERE notebook_id = $1", [notebookId]);
  return res.rowsAffected;
}

/* ------------------------------- Settings ------------------------------ */

export async function getSetting(key: string): Promise<string> {
  const d = await getDb();
  const rows = await d.select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key = $1",
    [key]
  );
  return rows[0]?.value ?? "";
}

export async function setSetting(key: string, value: string): Promise<void> {
  const d = await getDb();
  await d.execute(
    "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2",
    [key, value]
  );
}

/* ---------------------------- Data management ---------------------------- */

/** Flush WAL sidecars into the main db file so a backup copy is self-contained. */
export async function checkpointWal(): Promise<void> {
  const d = await getDb();
  await d.execute("PRAGMA wal_checkpoint(TRUNCATE)");
}

/** Close the shared connection (restore/factory-reset replace the file after). */
export async function closeDb(): Promise<void> {
  if (!dbPromise) return;
  const d = await dbPromise;
  dbPromise = null;
  await d.close();
}

/** Factory reset: wipe every row from every table (schema and file stay), and every media file. */
export async function clearAllData(): Promise<void> {
  const d = await getDb();
  for (const t of [
    "messages",
    "chats",
    "sources",
    "source_chunks",
    "artifacts",
    "notebooks",
    "folders",
    "devices",
    "jobs",
    "activity",
    "usage_events",
    "images",
    "settings",
    // Last: the deletes above leave tombstones. A fresh device id and
    // backfill are created on the next launch.
    "sync_meta",
    "sync_outbox",
    "sync_state",
    "sync_record_blobs",
  ]) {
    await d.execute(`DELETE FROM ${t}`);
  }
  await gcBlobs([], 0);
}

/* ------------------------- Phone sharing: devices ------------------------ */

export interface SharedDevice {
  id: string;
  name: string;
  scope: "read" | "full";
  created_at: number;
  last_seen: number;
  revoked_at: number;
}

export interface ActivityEntry {
  id: string;
  device_id: string;
  action: string;
  detail: string;
  created_at: number;
}

export async function listDevices(includeRevoked = false): Promise<SharedDevice[]> {
  const d = await getDb();
  return d.select<SharedDevice[]>(
    `SELECT * FROM devices ${includeRevoked ? "" : "WHERE revoked_at = 0"} ORDER BY created_at DESC`
  );
}

export async function revokeDevice(id: string): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE devices SET revoked_at = $1 WHERE id = $2", [Date.now(), id]);
}

export async function listActivity(limit = 20): Promise<ActivityEntry[]> {
  const d = await getDb();
  return d.select<ActivityEntry[]>(
    "SELECT * FROM activity ORDER BY created_at DESC LIMIT $1",
    [limit]
  );
}
