/**
 * Applying pulled BrewLM Sync changes to the local database — the web build's
 * copy of src-tauri/src/sync.rs (the desktop app runs that one). Keep the two
 * in step: syncApply.test.ts mirrors the Rust tests.
 *
 * Each batch is written in ONE transaction with `sync_state.applying = '1'`,
 * so the change-tracking triggers stay silent (a pulled change must not bounce
 * back out). The web database runs these synchronously inside its worker
 * (platform/webDbWorker.ts), so no other query can land mid-transaction.
 *
 * Conflicts are last-writer-wins per row on the HLC string
 * (`<13-digit ms>:<4-digit counter>:<device id>`, which sorts correctly as
 * text). A row's local version is its pending outbox edit if there is one,
 * else the HLC it was last synced at. Equal or older remote versions are
 * skipped. Only columns this version of the app knows are written, so a
 * newer device's extra columns can't break an older one.
 */
import type { PushedChange, RemoteChange } from "../platform/types";
import { SYNCED_TABLES } from "./syncTables";

/** A synchronous SQLite connection (the worker's), `?` placeholders. */
export interface SyncSqlite {
  all<T>(sql: string, bind?: unknown[]): T[];
  run(sql: string, bind?: unknown[]): void;
}

const localHlc = (ms: number, device: string) => `${String(ms).padStart(13, "0")}:0000:${device}`;
const hlcMs = (hlc: string) => Number(hlc.split(":")[0]) || 0;

/** How a JSON value from another device is stored (matches sync.rs `bind_value`). */
function sqlValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string") return v;
  return JSON.stringify(v);
}

function transaction<T>(db: SyncSqlite, body: () => T): T {
  db.run("BEGIN IMMEDIATE");
  try {
    const out = body();
    db.run("COMMIT");
    return out;
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
}

export function applyChanges(db: SyncSqlite, deviceId: string, changes: RemoteChange[]): { applied: number[] } {
  return transaction(db, () => {
    db.run("INSERT INTO sync_state (key, value) VALUES ('applying', '1') ON CONFLICT(key) DO UPDATE SET value = '1'");
    const applied: number[] = [];
    const known = new Map<string, Set<string>>();
    changes.forEach((c, i) => {
      const pk = Object.prototype.hasOwnProperty.call(SYNCED_TABLES, c.tbl) ? SYNCED_TABLES[c.tbl] : undefined;
      if (!pk) return;

      // Local version: a pending edit beats the last synced HLC.
      const [pending] = db.all<{ changed_at: number }>(
        "SELECT changed_at FROM sync_outbox WHERE tbl = ? AND row_id = ?",
        [c.tbl, c.row_id]
      );
      let local: string | undefined;
      if (pending) local = localHlc(pending.changed_at, deviceId);
      else {
        const [meta] = db.all<{ hlc: string; changed_at: number }>(
          "SELECT hlc, changed_at FROM sync_meta WHERE tbl = ? AND row_id = ?",
          [c.tbl, c.row_id]
        );
        if (meta) local = meta.hlc || localHlc(meta.changed_at, deviceId);
      }
      if (local !== undefined && local >= c.hlc) return;

      if (c.deleted) {
        db.run(`DELETE FROM ${c.tbl} WHERE ${pk} = ?`, [c.row_id]);
        if (c.tbl === "sources") db.run("DELETE FROM source_chunks WHERE source_id = ?", [c.row_id]);
      } else {
        const row = c.row;
        if (!row) return;
        if (row[pk] !== c.row_id) return; // a row must carry its own key
        let cols = known.get(c.tbl);
        if (!cols) {
          cols = new Set(db.all<{ name: string }>(`PRAGMA table_info(${c.tbl})`).map((r) => r.name));
          known.set(c.tbl, cols);
        }
        const names = Object.keys(row).filter((k) => cols.has(k));
        // Edited source text invalidates the local retrieval index (rebuilt lazily).
        if (c.tbl === "sources") {
          const [old] = db.all<{ content: string; text: string }>("SELECT content, text FROM sources WHERE id = ?", [c.row_id]);
          const str = (v: unknown) => (typeof v === "string" ? v : undefined);
          if (!old || old.content !== str(row.content) || old.text !== str(row.text))
            db.run("DELETE FROM source_chunks WHERE source_id = ?", [c.row_id]);
        }
        const updates = names.filter((n) => n !== pk).map((n) => `"${n}" = excluded."${n}"`);
        db.run(
          `INSERT INTO ${c.tbl} (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})
           ON CONFLICT (${pk}) DO ${updates.length ? `UPDATE SET ${updates.join(", ")}` : "NOTHING"}`,
          names.map((n) => sqlValue(row[n]))
        );
      }

      db.run(
        `INSERT INTO sync_meta (tbl, row_id, changed_at, deleted, hlc) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tbl, row_id) DO UPDATE SET changed_at = excluded.changed_at,
           deleted = excluded.deleted, hlc = excluded.hlc`,
        [c.tbl, c.row_id, hlcMs(c.hlc), c.deleted ? 1 : 0, c.hlc]
      );
      db.run("DELETE FROM sync_outbox WHERE tbl = ? AND row_id = ?", [c.tbl, c.row_id]);
      applied.push(i);
    });
    db.run("DELETE FROM sync_state WHERE key = 'applying'");
    return { applied };
  });
}

/**
 * After a push: record the HLC each row was synced at and clear its outbox
 * entry, unless the row was edited again while the push was in flight.
 */
export function markPushed(db: SyncSqlite, pushed: PushedChange[]): void {
  transaction(db, () => {
    for (const p of pushed) {
      if (p.hlc !== null) db.run("UPDATE sync_meta SET hlc = ? WHERE tbl = ? AND row_id = ?", [p.hlc, p.tbl, p.row_id]);
      db.run("DELETE FROM sync_outbox WHERE tbl = ? AND row_id = ? AND changed_at = ?", [p.tbl, p.row_id, p.changed_at]);
    }
  });
}
