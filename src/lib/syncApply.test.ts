// Mirrors the tests in src-tauri/src/sync.rs, against the SQLite build the web app uses.
import sqlite3InitModule, { type Database } from "@sqlite.org/sqlite-wasm";
import { beforeAll, describe, expect, it } from "vitest";
import type { RemoteChange } from "../platform/types";
import { applyChanges, markPushed, type SyncSqlite } from "./syncApply";

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THEM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>;
beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

type Conn = SyncSqlite & { one<T>(sql: string): T | undefined };

function wrap(db: Database): Conn {
  const all = <T,>(sql: string, bind?: unknown[]) =>
    db.selectObjects(sql, bind?.length ? (bind as never) : undefined) as T[];
  return {
    all,
    run: (sql, bind) => void db.exec({ sql, bind: bind?.length ? (bind as never) : undefined }),
    one: <T,>(sql: string) => all<T>(sql)[0],
  };
}

/** The tracked-table setup db.ts creates, for one table plus sources. */
function db(): Conn {
  const c = wrap(new sqlite3.oo1.DB(":memory:"));
  for (const sql of [
    "CREATE TABLE chats (id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL, title TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE sources (id TEXT PRIMARY KEY, content TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '')",
    "CREATE TABLE source_chunks (id TEXT PRIMARY KEY, source_id TEXT NOT NULL)",
    "CREATE TABLE sync_meta (tbl TEXT NOT NULL, row_id TEXT NOT NULL, changed_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL DEFAULT '', PRIMARY KEY (tbl, row_id))",
    "CREATE TABLE sync_outbox (tbl TEXT NOT NULL, row_id TEXT NOT NULL, changed_at INTEGER NOT NULL, PRIMARY KEY (tbl, row_id))",
    "CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    `CREATE TRIGGER t_chats AFTER UPDATE ON chats WHEN NOT EXISTS (SELECT 1 FROM sync_state WHERE key = 'applying' AND value = '1')
     BEGIN INSERT INTO sync_outbox (tbl, row_id, changed_at) VALUES ('chats', NEW.id, ${NOW})
     ON CONFLICT (tbl, row_id) DO UPDATE SET changed_at = excluded.changed_at; END`,
    "INSERT INTO chats VALUES ('c1', 'n1', 'Local title', 0)",
  ])
    c.run(sql);
  return c;
}

const hlc = (ms: number, device = THEM) => `${String(ms).padStart(13, "0")}:0000:${device}`;
const change = (rowId: string, ms: number, row?: Record<string, unknown>): RemoteChange => ({
  tbl: "chats",
  row_id: rowId,
  hlc: hlc(ms),
  deleted: !row,
  row,
});
const title = (c: Conn, id: string) => c.all<{ title: string }>("SELECT title FROM chats WHERE id = ?", [id])[0]?.title;
const count = (c: Conn, sql: string) => c.one<{ n: number }>(sql)!.n;

describe("applying pulled changes", () => {
  it("lets a newer remote version win, silently", () => {
    const c = db();
    c.run("INSERT INTO sync_meta VALUES ('chats', 'c1', 1000, 0, ?)", [hlc(1000, ME)]);
    const r = applyChanges(c, ME, [change("c1", 2000, { id: "c1", notebook_id: "n1", title: "Remote", pinned: 1, unknown_col: 5 })]);
    expect(r.applied).toEqual([0]);
    expect(title(c, "c1")).toBe("Remote");
    // The trigger didn't fire: nothing to bounce back out.
    expect(count(c, "SELECT count(*) AS n FROM sync_outbox")).toBe(0);
    expect(c.one<{ hlc: string }>("SELECT hlc FROM sync_meta WHERE row_id = 'c1'")!.hlc.startsWith("0000000002000")).toBe(true);
    // And the flag is gone: later local edits are tracked again.
    c.run("UPDATE chats SET title = 'Edited' WHERE id = 'c1'");
    expect(count(c, "SELECT count(*) AS n FROM sync_outbox")).toBe(1);
  });

  it("keeps a pending local edit over an older remote one", () => {
    const c = db();
    c.run("INSERT INTO sync_outbox VALUES ('chats', 'c1', 5000)");
    const r = applyChanges(c, ME, [change("c1", 4000, { id: "c1", notebook_id: "n1", title: "Older remote" })]);
    expect(r.applied).toEqual([]);
    expect(title(c, "c1")).toBe("Local title");
    // ...but a newer remote beats it, and the losing local edit is dropped.
    applyChanges(c, ME, [change("c1", 6000, { id: "c1", notebook_id: "n1", title: "Newer remote" })]);
    expect(title(c, "c1")).toBe("Newer remote");
    expect(count(c, "SELECT count(*) AS n FROM sync_outbox")).toBe(0);
  });

  it("handles deletes, inserts and rows it shouldn't trust", () => {
    const c = db();
    applyChanges(c, ME, [change("c1", 9000), change("c2", 9000, { id: "c2", notebook_id: "n1", title: "New" })]);
    expect(title(c, "c1")).toBeUndefined();
    expect(title(c, "c2")).toBe("New");
    expect(c.one<{ deleted: number }>("SELECT deleted FROM sync_meta WHERE row_id = 'c1'")!.deleted).toBe(1);
    // A row whose key doesn't match is ignored; unknown tables too.
    const bad = change("c3", 9000, { id: "other", notebook_id: "n", title: "x" });
    expect(applyChanges(c, ME, [bad]).applied).toEqual([]);
    expect(applyChanges(c, ME, [{ ...bad, tbl: "devices" }]).applied).toEqual([]);
    expect(applyChanges(c, ME, [{ ...bad, tbl: "toString" }]).applied).toEqual([]);
  });

  it("drops a source's index when its text changed", () => {
    const c = db();
    c.run("INSERT INTO sources VALUES ('s1', 'old', '')");
    c.run("INSERT INTO source_chunks VALUES ('k1', 's1')");
    const src = (content: string, ms: number): RemoteChange => ({
      tbl: "sources",
      row_id: "s1",
      hlc: hlc(ms),
      deleted: false,
      row: { id: "s1", content, text: "" },
    });
    applyChanges(c, ME, [src("old", 100)]);
    expect(count(c, "SELECT count(*) AS n FROM source_chunks")).toBe(1); // same text keeps the index
    applyChanges(c, ME, [src("new", 200)]);
    expect(count(c, "SELECT count(*) AS n FROM source_chunks")).toBe(0);
  });

  it("rolls the whole batch back on an error", () => {
    const c = db();
    expect(() =>
      applyChanges(c, ME, [
        change("c2", 9000, { id: "c2", notebook_id: "n1", title: "Kept?" }),
        change("c3", 9000, { id: "c3", notebook_id: null, title: "Breaks NOT NULL" }),
      ])
    ).toThrow();
    expect(title(c, "c2")).toBeUndefined();
    expect(count(c, "SELECT count(*) AS n FROM sync_state WHERE key = 'applying'")).toBe(0);
  });
});

describe("after a push", () => {
  it("keeps edits made while the push was in flight", () => {
    const c = db();
    c.run("INSERT INTO sync_meta VALUES ('chats', 'c1', 100, 0, '')");
    c.run("INSERT INTO sync_outbox VALUES ('chats', 'c1', 100), ('chats', 'c2', 300)");
    markPushed(c, [
      { tbl: "chats", row_id: "c1", changed_at: 100, hlc: hlc(100, ME) },
      // c2 was edited again (300) after we read it at 200: keep its entry.
      { tbl: "chats", row_id: "c2", changed_at: 200, hlc: null },
    ]);
    expect(c.all<{ row_id: string }>("SELECT row_id FROM sync_outbox").map((r) => r.row_id)).toEqual(["c2"]);
    expect(c.one<{ hlc: string }>("SELECT hlc FROM sync_meta WHERE row_id = 'c1'")!.hlc).toBe(hlc(100, ME));
  });
});
