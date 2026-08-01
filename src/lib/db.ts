import Database from "@tauri-apps/plugin-sql";
import { CONSTITUTION_BODY, CONSTITUTION_TITLE } from "./constitution";
import type { Artifact, ArtifactKind, ChatMessage, Notebook, Source, SourceType } from "./types";

export function uid(): string {
  return crypto.randomUUID();
}

let db: Database | null = null;

export async function getDb(): Promise<Database> {
  if (db) return db;
  db = await Database.load("sqlite:openmind.db");
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
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_sources_nb ON sources(notebook_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_messages_nb ON messages(notebook_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_artifacts_nb ON artifacts(notebook_id)`);
  return db;
}

/* ------------------------------ Notebooks ------------------------------ */

export async function listNotebooks(): Promise<Notebook[]> {
  const d = await getDb();
  return d.select<Notebook[]>(
    "SELECT * FROM notebooks ORDER BY updated_at DESC"
  );
}

export async function createNotebook(title: string): Promise<Notebook> {
  const d = await getDb();
  const now = Date.now();
  const nb: Notebook = { id: uid(), title, created_at: now, updated_at: now };
  await d.execute(
    "INSERT INTO notebooks (id, title, created_at, updated_at) VALUES ($1, $2, $3, $4)",
    [nb.id, nb.title, nb.created_at, nb.updated_at]
  );
  // Every notebook starts with its constitution as an editable source.
  await addSource(nb.id, "context", CONSTITUTION_TITLE, CONSTITUTION_BODY);
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

export async function touchNotebook(id: string): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE notebooks SET updated_at = $1 WHERE id = $2", [Date.now(), id]);
}

export async function deleteNotebook(id: string): Promise<void> {
  const d = await getDb();
  await d.execute("DELETE FROM sources WHERE notebook_id = $1", [id]);
  await d.execute("DELETE FROM messages WHERE notebook_id = $1", [id]);
  await d.execute("DELETE FROM artifacts WHERE notebook_id = $1", [id]);
  await d.execute("DELETE FROM notebooks WHERE id = $1", [id]);
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

export async function listMessages(notebookId: string): Promise<ChatMessage[]> {
  const d = await getDb();
  return d.select<ChatMessage[]>(
    "SELECT * FROM messages WHERE notebook_id = $1 ORDER BY created_at ASC",
    [notebookId]
  );
}

export async function addMessage(
  notebookId: string,
  role: "user" | "assistant",
  content: string
): Promise<ChatMessage> {
  const d = await getDb();
  const msg: ChatMessage = {
    id: uid(),
    notebook_id: notebookId,
    role,
    content,
    created_at: Date.now(),
  };
  await d.execute(
    "INSERT INTO messages (id, notebook_id, role, content, created_at) VALUES ($1, $2, $3, $4, $5)",
    [msg.id, msg.notebook_id, msg.role, msg.content, msg.created_at]
  );
  await touchNotebook(notebookId);
  return msg;
}

export async function clearMessages(notebookId: string): Promise<void> {
  const d = await getDb();
  await d.execute("DELETE FROM messages WHERE notebook_id = $1", [notebookId]);
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
