import Database from "@tauri-apps/plugin-sql";
import type { Artifact, ArtifactKind, Chat, ChatMessage, Folder, Notebook, Source, SourceType } from "./types";

export function uid(): string {
  return crypto.randomUUID();
}

let db: Database | null = null;

export async function getDb(): Promise<Database> {
  if (db) return db;
  db = await Database.load("sqlite:brewlm.db");
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
  await db.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
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
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_sources_nb ON sources(notebook_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_messages_nb ON messages(notebook_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_chats_nb ON chats(notebook_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_artifacts_nb ON artifacts(notebook_id)`);
  return db;
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
    folder_id: folderId,
    trashed_at: 0,
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
 * Deep-copy a notebook: description/cover/star/folder + sources + artifacts
 * always; chat threads and their messages only when includeChats (full clone
 * vs. "Use as template", which skips conversation history).
 */
export async function cloneNotebook(
  srcId: string,
  title: string,
  opts: { includeChats: boolean }
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
    folder_id: src.folder_id,
    trashed_at: 0,
    created_at: now,
    updated_at: now,
  };
  await d.execute(
    "INSERT INTO notebooks (id, title, description, starred, cover, folder_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [nb.id, nb.title, nb.description, nb.starred, nb.cover, nb.folder_id, nb.created_at, nb.updated_at]
  );

  for (const s of await listSources(srcId)) {
    await d.execute(
      "INSERT INTO sources (id, notebook_id, type, title, content, mime, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [uid(), nb.id, s.type, s.title, s.content, s.mime, now]
    );
  }
  for (const a of await d.select<Artifact[]>(
    "SELECT * FROM artifacts WHERE notebook_id = $1",
    [srcId]
  )) {
    await d.execute(
      "INSERT INTO artifacts (id, notebook_id, kind, title, data, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [uid(), nb.id, a.kind, a.title, a.data, now]
    );
  }
  if (opts.includeChats) {
    const chatIdMap = new Map<string, string>();
    for (const c of await listChats(srcId)) {
      const newId = uid();
      chatIdMap.set(c.id, newId);
      await d.execute(
        "INSERT INTO chats (id, notebook_id, title, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)",
        [newId, nb.id, c.title, c.created_at, c.updated_at]
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

/** Cover images are cosmetic — like starring, they must not bump updated_at. */
export async function setNotebookCover(id: string, cover: string): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE notebooks SET cover = $1 WHERE id = $2", [cover, id]);
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
  await d.execute("DELETE FROM messages WHERE notebook_id = $1", [id]);
  await d.execute("DELETE FROM chats WHERE notebook_id = $1", [id]);
  await d.execute("DELETE FROM artifacts WHERE notebook_id = $1", [id]);
  await d.execute("DELETE FROM notebooks WHERE id = $1", [id]);
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
  await d.execute("UPDATE folders SET cover = $1 WHERE id = $2", [cover, id]);
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
  mime: string | null = null
): Promise<Source> {
  const d = await getDb();
  const src: Source = {
    id: uid(),
    notebook_id: notebookId,
    type,
    title,
    content,
    mime,
    created_at: Date.now(),
  };
  await d.execute(
    "INSERT INTO sources (id, notebook_id, type, title, content, mime, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [src.id, src.notebook_id, src.type, src.title, src.content, src.mime, src.created_at]
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
    content,
    id,
  ]);
}

export async function deleteSource(id: string): Promise<void> {
  const d = await getDb();
  await d.execute("DELETE FROM sources WHERE id = $1", [id]);
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

export async function clearMessages(chatId: string): Promise<void> {
  const d = await getDb();
  await d.execute("DELETE FROM messages WHERE chat_id = $1", [chatId]);
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
  };
  await d.execute(
    "INSERT INTO chats (id, notebook_id, title, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)",
    [chat.id, chat.notebook_id, chat.title, chat.created_at, chat.updated_at]
  );
  await touchNotebook(notebookId);
  return chat;
}

export async function renameChat(id: string, title: string): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE chats SET title = $1 WHERE id = $2", [title, id]);
}

export async function touchChat(id: string): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE chats SET updated_at = $1 WHERE id = $2", [Date.now(), id]);
}

export async function deleteChat(id: string): Promise<void> {
  const d = await getDb();
  await d.execute("DELETE FROM messages WHERE chat_id = $1", [id]);
  await d.execute("DELETE FROM chats WHERE id = $1", [id]);
}

/* ------------------------------ Artifacts ------------------------------ */

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
    data,
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

/** Rewrite an artifact's payload in place (Studio "Revise" → Replace original). */
export async function updateArtifact(id: string, data: string): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE artifacts SET data = $1 WHERE id = $2", [data, id]);
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
