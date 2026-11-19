// Writing a shared link's notebook (share.ts) on the SQLite build the web app uses.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { beforeAll, describe, expect, it, vi } from "vitest";

let conn: {
  execute(sql: string, b?: unknown[]): Promise<{ rowsAffected: number }>;
  select<T>(sql: string, b?: unknown[]): Promise<T>;
};
vi.mock("../platform", () => ({ platform: {} }));
vi.mock("./db", () => ({ getDb: async () => conn, uid: () => crypto.randomUUID() }));

import { writeSharedSnapshot, SNAPSHOT_FORMAT, SNAPSHOT_VERSION, type NotebookSnapshot } from "./share";

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>;
beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

function open() {
  const db = new sqlite3.oo1.DB(":memory:");
  const bind = (b?: unknown[]) => (b?.length ? (b as never) : undefined);
  for (const sql of [
    "CREATE TABLE notebooks (id TEXT PRIMARY KEY, title TEXT, description TEXT, starred INTEGER, cover TEXT, chat_bg TEXT, chat_bg_dim INTEGER, folder_id TEXT, grounded INTEGER, constitution_on INTEGER, share_id TEXT, share_key TEXT, share_version INTEGER, shared_by TEXT, trashed_at INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER)",
    "CREATE TABLE sources (id TEXT PRIMARY KEY, notebook_id TEXT, type TEXT, title TEXT, content TEXT, mime TEXT, pinned INTEGER, text TEXT, created_at INTEGER)",
    "CREATE TABLE source_chunks (id TEXT PRIMARY KEY, source_id TEXT, notebook_id TEXT, seq INTEGER, page INTEGER, text TEXT, embedding TEXT)",
    "CREATE TABLE artifacts (id TEXT PRIMARY KEY, notebook_id TEXT, kind TEXT, title TEXT, data TEXT, pinned INTEGER, usage TEXT, created_at INTEGER)",
    "CREATE TABLE chats (id TEXT PRIMARY KEY, notebook_id TEXT, title TEXT, pinned INTEGER, from_share INTEGER, created_at INTEGER, updated_at INTEGER)",
    "CREATE TABLE images (id TEXT PRIMARY KEY, notebook_id TEXT, chat_id TEXT, prompt TEXT, model TEXT, mime TEXT, data TEXT, width INTEGER, height INTEGER, parent_id TEXT, created_at INTEGER)",
    "CREATE TABLE messages (id TEXT PRIMARY KEY, notebook_id TEXT, chat_id TEXT, role TEXT, content TEXT, created_at INTEGER)",
    "CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  ])
    db.exec(sql);
  conn = {
    execute: async (sql, b) => {
      db.exec({ sql: sql.replace(/\$\d+/g, "?"), bind: bind(b) });
      return { rowsAffected: db.changes() };
    },
    select: async <T,>(sql: string, b?: unknown[]) => db.selectObjects(sql.replace(/\$\d+/g, "?"), bind(b)) as T,
  };
  return db;
}

const snap: NotebookSnapshot = {
  format: SNAPSHOT_FORMAT,
  version: SNAPSHOT_VERSION,
  created_at: 1,
  notebook: { title: "Shared", description: "", cover: "", chat_bg: "", chat_bg_dim: 55, grounded: 1, constitution_on: 1 },
  sources: [{ id: "s1", notebook_id: "x", type: "text", title: "One", content: "hello", mime: null, text: "", pinned: 0, created_at: 1 }],
  chunks: [{ id: "k1", source_id: "s1", notebook_id: "x", seq: 0, page: null, text: "hello", embedding: "" }],
  artifacts: [],
  chats: [],
  messages: [],
  images: [],
};
const origin = { id: "a".repeat(32), key: "k", version: 1, sharedBy: "" };

describe("writeSharedSnapshot", () => {
  it("opens a link whose earlier open crashed part-way, first time", async () => {
    const db = open();
    // The crashed open: rows written, notebook row never reached.
    const nbId = await writeSharedSnapshot(snap, origin);
    db.exec({ sql: "DELETE FROM notebooks WHERE id = ?", bind: [nbId] });
    db.exec("INSERT INTO sync_state VALUES ('share_writing', '1') ON CONFLICT(key) DO UPDATE SET value = '1'");

    expect(await writeSharedSnapshot(snap, origin)).toBe(nbId);
    expect(db.selectObjects("SELECT title FROM sources WHERE notebook_id = ?", [nbId] as never)).toEqual([{ title: "One" }]);
    expect(db.selectObjects("SELECT count(*) AS n FROM source_chunks")).toEqual([{ n: 1 }]);
    expect(db.selectObjects("SELECT value FROM sync_state WHERE key = 'share_writing'")).toEqual([{ value: "0" }]);
  });
});
