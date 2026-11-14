// The read-only triggers on notebooks opened from a shared link (db.ts), on the SQLite build the web app uses.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../platform", () => ({ platform: {} }));

import { ensureShareGuards, SHARED_READ_ONLY } from "./db";

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>;
beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

function open() {
  const db = new sqlite3.oo1.DB(":memory:");
  const bind = (b?: unknown[]) => (b?.length ? (b as never) : undefined);
  const conn = {
    execute: async (sql: string, b?: unknown[]) => {
      db.exec({ sql: sql.replace(/\$\d+/g, "?"), bind: bind(b) });
      return { rowsAffected: db.changes() };
    },
    select: async <T,>(sql: string, b?: unknown[]) => db.selectObjects(sql.replace(/\$\d+/g, "?"), bind(b)) as T,
    close: async () => db.close(),
  };
  for (const sql of [
    "CREATE TABLE notebooks (id TEXT PRIMARY KEY, share_id TEXT NOT NULL DEFAULT '')",
    "CREATE TABLE sources (id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', pinned INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL DEFAULT '')",
    "CREATE TABLE artifacts (id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, data TEXT NOT NULL)",
    "CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    "INSERT INTO notebooks VALUES ('mine', ''), ('theirs', 'abc')",
  ])
    db.exec(sql);
  return conn;
}

describe("shared notebook guards", () => {
  it("are back on at startup after a crash left them switched off", async () => {
    const db = open();
    await db.execute("INSERT INTO sync_state VALUES ('share_writing', '1')");
    await ensureShareGuards(db);
    await expect(db.execute("INSERT INTO sources (id, notebook_id, title) VALUES ('t9', 'theirs', 'X')")).rejects.toThrow(
      SHARED_READ_ONLY
    );
  });

  it("refuses changes to a shared notebook's sources and outputs, and allows the rest", async () => {
    const db = open();
    await ensureShareGuards(db);
    const refused = (sql: string) => expect(db.execute(sql)).rejects.toThrow(SHARED_READ_ONLY);

    await db.execute("INSERT INTO sources (id, notebook_id, title) VALUES ('m1', 'mine', 'Mine')");
    await refused("INSERT INTO sources (id, notebook_id, title) VALUES ('t1', 'theirs', 'Theirs')");
    await refused("INSERT INTO artifacts VALUES ('a1', 'theirs', 'notes', 'N', '')");

    // A link's own content goes in while share_writing is set.
    await db.execute("INSERT INTO sync_state VALUES ('share_writing', '1')");
    await db.execute("INSERT INTO sources (id, notebook_id, title) VALUES ('t1', 'theirs', 'Theirs')");
    await db.execute("UPDATE sync_state SET value = '0' WHERE key = 'share_writing'");

    await refused("UPDATE sources SET title = 'Renamed' WHERE id = 't1'");
    await refused("UPDATE sources SET content = 'x' WHERE id = 't1'");
    await refused("DELETE FROM sources WHERE id = 't1'");
    // Per-person and derived fields stay open: pins, transcripts.
    await db.execute("UPDATE sources SET pinned = 1, text = 'transcript' WHERE id = 't1'");
    await db.execute("UPDATE sources SET title = 'Renamed' WHERE id = 'm1'");

    // Deleting the notebook row first frees its leftovers.
    await db.execute("DELETE FROM notebooks WHERE id = 'theirs'");
    await db.execute("DELETE FROM sources WHERE notebook_id = 'theirs'");
    expect(await db.select<unknown[]>("SELECT * FROM sources")).toHaveLength(1);
  });
});
