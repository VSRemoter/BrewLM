/**
 * One vault = one user's synced library, held by its own Durable Object.
 *
 * The server never interprets records: each change is an opaque `payload`
 * string (encrypted from milestone 2c) stored under a `key` with the HLC
 * version the device assigned. Only the newest version of each key is kept,
 * so the log compacts itself and a fresh device pulling from 0 receives the
 * current state, not history.
 *
 * Ordering: every accepted change gets the next `seq`; devices pull
 * `seq > cursor`. Conflicts are last-writer-wins on the HLC string, which
 * sorts by time, then counter, then device id.
 *
 * Storage: the vault keeps running totals of record and blob bytes and
 * refuses writes that would take it past the caller's plan limit (writes that
 * shrink it, like deletes, always go through).
 *
 * Unused files: the server can't read which files the library still uses, so
 * an up-to-date device sends the list (`sweep`) and the rest are deleted. The
 * list counts only if no change has arrived since the device's cursor, and a
 * file younger than SWEEP_GRACE_MS is kept (a device may be about to use it).
 * Each sweep that deletes something bumps `epoch`, sent with every pull, so
 * devices re-check that the files they use are still here.
 */
import { DurableObject } from "cloudflare:workers";

export const HLC_RE = /^\d{13}:\d{4}:[0-9a-f-]{36}$/;
export const MAX_KEY = 256;
/** Durable Object rows cap at 2 MB; bigger records move to R2 in milestone 2b. */
export const MAX_PAYLOAD = 1_500_000;
export const MAX_PUSH = 500;
export const MAX_PULL = 500;
/** The key envelope is a few hundred bytes of JSON; anything near this is junk. */
export const MAX_ENVELOPE = 16 * 1024;
/** A device link waits this long for the new device, then is gone. */
export const LINK_TTL_MS = 10 * 60 * 1000;
const MAX_LINKS = 5;
/** A file this young is never swept: its record may still be on its way. */
export const SWEEP_GRACE_MS = 10 * 60 * 1000;

// Type aliases (not interfaces) so they satisfy SqlStorage's row constraint.
export type Change = {
  key: string;
  hlc: string;
  payload: string;
};

export type StoredChange = Change & {
  seq: number;
  device: string;
};

class StorageFull extends Error {}

export class Vault extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS changes (
      key TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      hlc TEXT NOT NULL,
      device TEXT NOT NULL,
      payload TEXT NOT NULL
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS changes_seq ON changes(seq)");
    // The vault key, wrapped by the password and by the recovery key (see the
    // app's vaultCrypto.ts). The server can't unwrap it; it only stores it.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS vault_keys (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      envelope TEXT NOT NULL,
      version INTEGER NOT NULL
    )`);
    // One-time device links: the vault key sealed with a secret only the QR
    // code carries, waiting (briefly) for the new device to take it.
    this.sql.exec("CREATE TABLE IF NOT EXISTS usage (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, size INTEGER NOT NULL)");
    // When each file was (last) written, for the sweep's grace period. Files
    // from before this column count as old.
    const blobCols = this.sql.exec<{ name: string }>("PRAGMA table_info(blobs)").toArray();
    if (!blobCols.some((c) => c.name === "created_at"))
      this.sql.exec("ALTER TABLE blobs ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0");
    this.sql.exec("INSERT OR IGNORE INTO usage (k, v) VALUES ('epoch', 0)");
    // Vaults from before storage tracking: count what they already hold, once.
    this.sql.exec(
      "INSERT OR IGNORE INTO usage (k, v) SELECT 'records', coalesce(sum(length(payload)), 0) FROM changes"
    );
    this.sql.exec(`CREATE TABLE IF NOT EXISTS links (
      id TEXT PRIMARY KEY,
      sealed TEXT NOT NULL,
      expires INTEGER NOT NULL
    )`);
  }

  private purgeLinks(): void {
    this.sql.exec("DELETE FROM links WHERE expires <= ?", Date.now());
  }

  putLink(id: string, sealed: string): { ok: boolean; expires: number } {
    this.purgeLinks();
    const open = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM links WHERE id != ?", id).one().n;
    if (open >= MAX_LINKS) return { ok: false, expires: 0 };
    const expires = Date.now() + LINK_TTL_MS;
    this.sql.exec(
      "INSERT INTO links (id, sealed, expires) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET sealed = excluded.sealed, expires = excluded.expires",
      id,
      sealed,
      expires
    );
    return { ok: true, expires };
  }

  /** Hand the sealed key over once: it's deleted as it's read. */
  takeLink(id: string): string | null {
    this.purgeLinks();
    const row = this.sql.exec<{ sealed: string }>("SELECT sealed FROM links WHERE id = ?", id).toArray()[0];
    if (row) this.sql.exec("DELETE FROM links WHERE id = ?", id);
    return row?.sealed ?? null;
  }

  /** Still waiting? (false once used, cancelled or expired) */
  linkPending(id: string): boolean {
    this.purgeLinks();
    return this.sql.exec("SELECT 1 FROM links WHERE id = ?", id).toArray().length > 0;
  }

  cancelLink(id: string): void {
    this.sql.exec("DELETE FROM links WHERE id = ?", id);
  }

  getKeys(): { envelope: string | null; version: number } {
    const row = this.sql.exec<{ envelope: string; version: number }>("SELECT envelope, version FROM vault_keys").toArray()[0];
    return { envelope: row?.envelope ?? null, version: row?.version ?? 0 };
  }

  /**
   * Replace the envelope only if the caller saw the current version (0 = none
   * yet), so two devices can't overwrite each other's password change.
   */
  putKeys(envelope: string, expectVersion: number): { ok: boolean; version: number } {
    const { version } = this.getKeys();
    if (version !== expectVersion) return { ok: false, version };
    this.sql.exec(
      `INSERT INTO vault_keys (id, envelope, version) VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET envelope = excluded.envelope, version = excluded.version`,
      envelope,
      version + 1
    );
    return { ok: true, version: version + 1 };
  }

  /** Bytes stored: records (the change log) and blobs (files in R2). */
  usage(): { records: number; blobs: number; total: number } {
    const records = this.sql.exec<{ v: number }>("SELECT v FROM usage WHERE k = 'records'").one().v;
    const blobs = this.sql.exec<{ s: number | null }>("SELECT sum(size) AS s FROM blobs").one().s ?? 0;
    return { records, blobs, total: records + blobs };
  }

  /**
   * Make room for a blob about to be written to R2 (a rewrite of the same id
   * replaces its old size). Not ok if it would go past `limit`. `prev` is the
   * size it had before (null = new), for `releaseBlob` if the write fails.
   */
  reserveBlob(id: string, size: number, limit: number): { ok: boolean; prev: number | null } {
    const prev = this.sql.exec<{ size: number }>("SELECT size FROM blobs WHERE id = ?", id).toArray()[0]?.size ?? null;
    if (size > (prev ?? 0) && this.usage().total - (prev ?? 0) + size > limit) return { ok: false, prev };
    this.sql.exec(
      `INSERT INTO blobs (id, size, created_at) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET size = excluded.size, created_at = excluded.created_at`,
      id,
      size,
      Date.now()
    );
    return { ok: true, prev };
  }

  /** Undo `reserveBlob` after the write to R2 failed, so it isn't counted. */
  releaseBlob(id: string, prev: number | null): void {
    if (prev === null) this.sql.exec("DELETE FROM blobs WHERE id = ?", id);
    else this.sql.exec("UPDATE blobs SET size = ? WHERE id = ?", prev, id);
  }

  /**
   * Forget every file not in `live` (and older than the grace period), if the
   * vault hasn't changed since `cursor`: the caller's view is current. The
   * caller deletes the returned ids from R2.
   */
  sweep(cursor: number, live: string[], now = Date.now()): { ok: false } | { ok: true; removed: string[]; freed: number } {
    if (cursor !== this.cursor()) return { ok: false };
    const keep = new Set(live);
    const old = this.sql
      .exec<{ id: string; size: number }>("SELECT id, size FROM blobs WHERE created_at < ?", now - SWEEP_GRACE_MS)
      .toArray()
      .filter((b) => !keep.has(b.id));
    if (old.length === 0) return { ok: true, removed: [], freed: 0 };
    this.ctx.storage.transactionSync(() => {
      for (const b of old) this.sql.exec("DELETE FROM blobs WHERE id = ?", b.id);
      this.sql.exec("UPDATE usage SET v = v + 1 WHERE k = 'epoch'");
    });
    return { ok: true, removed: old.map((b) => b.id), freed: old.reduce((n, b) => n + b.size, 0) };
  }

  /** Counted sizes of the given files and records (absent ones are left out). */
  sizes(blobIds: string[], keys: string[]): { blobs: Record<string, number>; keys: Record<string, number> } {
    const blobs: Record<string, number> = {};
    const out: Record<string, number> = {};
    for (const id of blobIds) {
      const row = this.sql.exec<{ size: number }>("SELECT size FROM blobs WHERE id = ?", id).toArray()[0];
      if (row) blobs[id] = row.size;
    }
    for (const k of keys) {
      const row = this.sql.exec<{ len: number }>("SELECT length(payload) AS len FROM changes WHERE key = ?", k).toArray()[0];
      if (row) out[k] = row.len;
    }
    return { blobs, keys: out };
  }

  private epoch(): number {
    return this.sql.exec<{ v: number }>("SELECT v FROM usage WHERE k = 'epoch'").one().v;
  }

  private cursor(): number {
    return (this.sql.exec<{ s: number | null }>("SELECT max(seq) AS s FROM changes").one().s ?? 0) as number;
  }

  /**
   * Store changes that are newer than what the vault holds; report the rest as
   * stale. The whole batch is refused (`full`) if it would grow the vault past
   * `limit` bytes.
   */
  push(
    device: string,
    changes: Change[],
    limit = Number.MAX_SAFE_INTEGER
  ): { accepted: number; stale: string[]; cursor: number; full?: boolean } {
    const stale: string[] = [];
    let accepted = 0;
    try {
      this.ctx.storage.transactionSync(() => {
        let seq = this.cursor();
        let delta = 0;
        for (const c of changes) {
          const cur = this.sql
            .exec<{ hlc: string; len: number }>("SELECT hlc, length(payload) AS len FROM changes WHERE key = ?", c.key)
            .toArray()[0];
          if (cur && cur.hlc >= c.hlc) {
            stale.push(c.key);
            continue;
          }
          delta += c.payload.length - (cur?.len ?? 0);
          seq += 1;
          this.sql.exec(
            `INSERT INTO changes (key, seq, hlc, device, payload) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (key) DO UPDATE SET seq = excluded.seq, hlc = excluded.hlc,
               device = excluded.device, payload = excluded.payload`,
            c.key,
            seq,
            c.hlc,
            device,
            c.payload
          );
          accepted += 1;
        }
        if (delta > 0 && this.usage().total + delta > limit) throw new StorageFull();
        this.sql.exec("UPDATE usage SET v = v + ? WHERE k = 'records'", delta);
      });
    } catch (e) {
      if (e instanceof StorageFull) return { accepted: 0, stale: [], cursor: this.cursor(), full: true };
      throw e;
    }
    return { accepted, stale, cursor: this.cursor() };
  }

  /** Changes after `since`, oldest first; `epoch` counts sweeps that deleted files. */
  pull(since: number, limit: number): { changes: StoredChange[]; cursor: number; more: boolean; epoch: number } {
    const rows = this.sql
      .exec<StoredChange>(
        "SELECT key, seq, hlc, device, payload FROM changes WHERE seq > ? ORDER BY seq LIMIT ?",
        since,
        limit + 1
      )
      .toArray();
    const more = rows.length > limit;
    const changes = more ? rows.slice(0, limit) : rows;
    return { changes, cursor: changes.length ? changes[changes.length - 1].seq : since, more, epoch: this.epoch() };
  }
}
