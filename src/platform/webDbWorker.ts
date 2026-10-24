/**
 * The web build's database: SQLite compiled to WebAssembly, stored in the
 * origin-private file system through the "opfs-sahpool" VFS (no special
 * server headers needed; Safari 16.4+, Chrome, Firefox). It runs in this
 * worker because that storage only offers synchronous access to workers.
 *
 * Requests are handled one at a time, in order, so a sync batch (applied
 * synchronously in one message) can't interleave with the app's own queries.
 */
import sqlite3InitModule, { type Database } from "@sqlite.org/sqlite-wasm";
import { applyChanges, markPushed, type SyncSqlite } from "../lib/syncApply";
import type { PushedChange, RemoteChange } from "./types";

export type DbRequest =
  | { op: "open" }
  | { op: "execute"; sql: string; bind?: unknown[] }
  | { op: "select"; sql: string; bind?: unknown[] }
  | { op: "apply"; deviceId: string; changes: RemoteChange[] }
  | { op: "markPushed"; pushed: PushedChange[] }
  | { op: "close" };

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>> | null = null;
let db: Database | null = null;

/** JS values as SQLite stores them (plugin-sql does the same on desktop). */
function sqlValue(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "object" && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v;
}

/**
 * The app writes plugin-sql's `$1`, `$2`… placeholders. SQLite treats those
 * as *names*, numbered in order of first appearance, so `SET a = $2 WHERE id
 * = $1` would swap the values if bound by position: bind them by name.
 */
function binds(sql: string, bind?: unknown[]): unknown[] | Record<string, unknown> | undefined {
  if (!bind?.length) return undefined;
  const values = bind.map(sqlValue);
  if (!/\$\d/.test(sql)) return values;
  const named: Record<string, unknown> = {};
  values.forEach((v, i) => {
    if (new RegExp(`\\$${i + 1}(?!\\d)`).test(sql)) named[`$${i + 1}`] = v;
  });
  return named;
}

function requireDb(): Database {
  if (!db) throw new Error("database isn't open");
  return db;
}

const syncConn = (d: Database): SyncSqlite => ({
  all: <T,>(sql: string, bind?: unknown[]) => d.selectObjects(sql, binds(sql, bind) as never) as T[],
  run: (sql, bind) => void d.exec({ sql, bind: binds(sql, bind) as never }),
});

async function open(): Promise<void> {
  if (db) return;
  sqlite3 ??= await sqlite3InitModule();
  let pool;
  try {
    pool = await sqlite3.installOpfsSAHPoolVfs({});
  } catch (e) {
    // The pool's files can only be held by one tab at a time.
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      /access handle|NoModificationAllowed|locked/i.test(msg)
        ? "BrewLM is already open in another tab or window. Close it there, then reload this page."
        : `Couldn't open storage in this browser: ${msg}`
    );
  }
  db = new pool.OpfsSAHPoolDb("/brewlm.db");
  db.exec("PRAGMA busy_timeout = 5000");
}

function handle(req: DbRequest): unknown {
  switch (req.op) {
    case "execute": {
      const d = requireDb();
      d.exec({ sql: req.sql, bind: binds(req.sql, req.bind) as never });
      return {
        rowsAffected: d.changes(),
        lastInsertId: Number(sqlite3!.capi.sqlite3_last_insert_rowid(d.pointer!)),
      };
    }
    case "select":
      return requireDb().selectObjects(req.sql, binds(req.sql, req.bind) as never);
    case "apply":
      return applyChanges(syncConn(requireDb()), req.deviceId, req.changes);
    case "markPushed":
      return markPushed(syncConn(requireDb()), req.pushed);
    case "close":
      db?.close();
      db = null;
      return true;
    case "open":
      return undefined;
  }
}

// Messages queue up while `open` is pending; each waits for the one before it.
let queue: Promise<unknown> = Promise.resolve();
self.onmessage = (e: MessageEvent<{ id: number; req: DbRequest }>) => {
  const { id, req } = e.data;
  queue = queue
    .then(() => (req.op === "open" ? open() : handle(req)))
    .then(
      (result) => self.postMessage({ id, result }),
      (err) => self.postMessage({ id, error: err instanceof Error ? err.message : String(err) })
    );
};
