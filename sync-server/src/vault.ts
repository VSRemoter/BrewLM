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
 * shrink it, like deletes, always go through). Each record counts its payload,
 * its key and a fixed overhead, so a flood of empty records isn't free. A file
 * counts from the moment its upload is let in (`reserveBlob`): an upload in
 * progress holds its full size, and when it lands (`commitBlob`) the size R2
 * reports replaces it. Anything stored under the vault in R2 counts, even if
 * the upload's bookkeeping was lost (`adoptBlob`, `settleUploads`).
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
/**
 * A file this young is never swept: its record may still be on its way. Kept
 * short so deleted files free their space soon; a file swept too early heals,
 * as the device that uploaded it sees the epoch change and uploads it again.
 */
export const SWEEP_GRACE_MS = 2 * 60 * 1000;
/** An upload still unfinished after this is checked against R2 and settled. */
export const STALE_UPLOAD_MS = 2 * 60 * 60 * 1000;
/** What a record costs beyond its payload and key (seq, version, device, row). */
export const RECORD_OVERHEAD = 100;
/** A record's counted size, in SQL over the `changes` table. */
const RECORD_BYTES = `length(payload) + length(key) + ${RECORD_OVERHEAD}`;
const ACCOUNTING_VERSION = 2;
/**
 * Records live in the Durable Object (10 GB at most, and dearer than R2):
 * whatever the plan, they stop here. The app moves rows over 1 MB to R2.
 */
export const MAX_RECORD_BYTES = 2 * 1024 ** 3;
/** Uploads let in per day (UTC): far above a real library's, and a cap on what a flood of them costs. */
export const MAX_UPLOADS_PER_DAY = 20_000;

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
    // R2's upload time of the counted copy: when two uploads of one file
    // overlap, the one R2 stored last is the one counted.
    if (!blobCols.some((c) => c.name === "uploaded_at"))
      this.sql.exec("ALTER TABLE blobs ADD COLUMN uploaded_at INTEGER NOT NULL DEFAULT 0");
    // Uploads let in but not landed yet; each holds its size until it settles.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS uploads (
      token TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      size INTEGER NOT NULL,
      started INTEGER NOT NULL
    )`);
    this.sql.exec("INSERT OR IGNORE INTO usage (k, v) VALUES ('epoch', 0)");
    // New vaults, and ones counted before keys and overhead were: (re)count records once.
    const acct = this.sql.exec<{ v: number }>("SELECT v FROM usage WHERE k = 'accounting'").toArray()[0]?.v ?? 0;
    if (acct < ACCOUNTING_VERSION)
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          `INSERT OR REPLACE INTO usage (k, v) SELECT 'records', coalesce(sum(${RECORD_BYTES}), 0) FROM changes`
        );
        this.sql.exec("INSERT OR REPLACE INTO usage (k, v) VALUES ('accounting', ?)", ACCOUNTING_VERSION);
      });
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

  /** Bytes stored: records (the change log) and blobs (files in R2, landed or on their way). */
  usage(): { records: number; blobs: number; total: number } {
    const records = this.sql.exec<{ v: number }>("SELECT v FROM usage WHERE k = 'records'").one().v;
    const landed = this.sql.exec<{ s: number | null }>("SELECT sum(size) AS s FROM blobs").one().s ?? 0;
    const moving = this.sql.exec<{ s: number | null }>("SELECT sum(size) AS s FROM uploads").one().s ?? 0;
    const blobs = landed + moving;
    return { records, blobs, total: records + blobs };
  }

  /**
   * Let an upload of `size` bytes in, if it fits under `limit`: it counts in
   * full until it settles, even when it replaces a copy of the same file. A
   * file that's no bigger than its counted copy is always let in (a retry).
   * Returns the token for `commitBlob` / `abortBlob`.
   */
  async reserveBlob(
    vault: string,
    id: string,
    size: number,
    limit: number,
    now = Date.now()
  ): Promise<{ ok: boolean; token: string; busy?: boolean }> {
    await this.settleUploads(vault, now);
    const day = `uploads:${new Date(now).toISOString().slice(0, 10)}`;
    const today = this.sql.exec<{ v: number }>("SELECT v FROM usage WHERE k = ?", day).toArray()[0]?.v ?? 0;
    if (today >= MAX_UPLOADS_PER_DAY) return { ok: false, token: "", busy: true };
    const counted = this.sql.exec<{ size: number }>("SELECT size FROM blobs WHERE id = ?", id).toArray()[0]?.size ?? -1;
    if (size > counted && this.usage().total + size > limit) return { ok: false, token: "" };
    const token = crypto.randomUUID();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO uploads (token, id, size, started) VALUES (?, ?, ?, ?)", token, id, size, now);
      // One counter per day; earlier days' go.
      this.sql.exec("DELETE FROM usage WHERE k LIKE 'uploads:%' AND k != ?", day);
      this.sql.exec("INSERT INTO usage (k, v) VALUES (?, 1) ON CONFLICT (k) DO UPDATE SET v = v + 1", day);
    });
    return { ok: true, token };
  }

  /** The upload landed: count the size R2 stored instead of the reservation. Returns bytes used. */
  commitBlob(token: string, id: string, size: number, uploadedAt: number, now = Date.now()): number {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM uploads WHERE token = ?", token);
      this.countBlob(id, size, uploadedAt, now);
    });
    return this.usage().total;
  }

  /** The upload failed: give its reservation back (the file's earlier copy, if any, still counts). */
  abortBlob(token: string): void {
    this.sql.exec("DELETE FROM uploads WHERE token = ?", token);
  }

  /** A file found in R2 that isn't counted (bookkeeping lost along the way) counts from now on. */
  adoptBlob(id: string, size: number, uploadedAt: number, now = Date.now()): void {
    if (this.sql.exec("SELECT 1 FROM blobs WHERE id = ?", id).toArray().length > 0) return;
    this.countBlob(id, size, uploadedAt, now);
  }

  /** Count R2's copy of a file unless a later one is already counted. */
  private countBlob(id: string, size: number, uploadedAt: number, now: number): void {
    this.sql.exec(
      `INSERT INTO blobs (id, size, created_at, uploaded_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET size = excluded.size, created_at = excluded.created_at,
         uploaded_at = excluded.uploaded_at
       WHERE excluded.uploaded_at >= blobs.uploaded_at`,
      id,
      size,
      now,
      uploadedAt
    );
  }

  /**
   * Uploads unfinished for hours were most likely cut off before their
   * bookkeeping: count whatever R2 holds for them and drop the reservation.
   */
  private async settleUploads(vault: string, now: number): Promise<void> {
    const stale = this.sql
      .exec<{ token: string; id: string }>("SELECT token, id FROM uploads WHERE started < ?", now - STALE_UPLOAD_MS)
      .toArray();
    for (const u of stale) {
      const obj = await this.env.BLOBS.head(`${vault}/${u.id}`);
      this.ctx.storage.transactionSync(() => {
        if (obj) this.countBlob(u.id, obj.size, obj.uploaded.getTime(), now);
        this.sql.exec("DELETE FROM uploads WHERE token = ?", u.token);
      });
    }
  }

  /**
   * Delete every file not in `live` (older than the grace period, and not
   * being uploaded right now), if the vault hasn't changed since `cursor`: the
   * caller's view is current. Files go from R2 first and stop counting after,
   * so an interrupted sweep can only leave a file counted, never stored free.
   * `waiting` files are unused but too new; `retryInMs` says when they can go.
   */
  async sweep(
    vault: string,
    cursor: number,
    live: string[],
    now = Date.now()
  ): Promise<
    { ok: false } | { ok: true; removed: number; freed: number; waiting: number; retryInMs: number; usedBytes: number }
  > {
    if (cursor !== this.cursor()) return { ok: false };
    const keep = new Set(live);
    const moving = new Set(this.sql.exec<{ id: string }>("SELECT id FROM uploads").toArray().map((u) => u.id));
    const unused = this.sql
      .exec<{ id: string; size: number; created_at: number }>("SELECT id, size, created_at FROM blobs")
      .toArray()
      .filter((b) => !keep.has(b.id) && !moving.has(b.id));
    const old = unused.filter((b) => b.created_at < now - SWEEP_GRACE_MS);
    const young = unused.filter((b) => b.created_at >= now - SWEEP_GRACE_MS);
    const retryInMs = young.length ? Math.max(0, Math.min(...young.map((b) => b.created_at)) + SWEEP_GRACE_MS - now) : 0;
    let removed = 0;
    let freed = 0;
    if (old.length > 0) {
      for (let i = 0; i < old.length; i += 1000)
        await this.env.BLOBS.delete(old.slice(i, i + 1000).map((b) => `${vault}/${b.id}`));
      this.ctx.storage.transactionSync(() => {
        for (const b of old) {
          // Rewritten while R2 was deleting it: devices re-check after the epoch bump.
          const same = this.sql.exec("SELECT 1 FROM blobs WHERE id = ? AND created_at = ?", b.id, b.created_at).toArray();
          if (same.length === 0) continue;
          this.sql.exec("DELETE FROM blobs WHERE id = ?", b.id);
          removed += 1;
          freed += b.size;
        }
        this.sql.exec("UPDATE usage SET v = v + 1 WHERE k = 'epoch'");
      });
    }
    return { ok: true, removed, freed, waiting: young.length, retryInMs, usedBytes: this.usage().total };
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
      const row = this.sql.exec<{ len: number }>(`SELECT ${RECORD_BYTES} AS len FROM changes WHERE key = ?`, k).toArray()[0];
      if (row) out[k] = row.len;
    }
    return { blobs, keys: out };
  }

  /** Which of these files are counted. */
  counted(ids: string[]): string[] {
    return ids.filter((id) => this.sql.exec("SELECT 1 FROM blobs WHERE id = ?", id).toArray().length > 0);
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
  ): { accepted: number; stale: string[]; cursor: number; usedBytes: number; full?: boolean } {
    const stale: string[] = [];
    let accepted = 0;
    try {
      this.ctx.storage.transactionSync(() => {
        let seq = this.cursor();
        let delta = 0;
        for (const c of changes) {
          const cur = this.sql
            .exec<{ hlc: string; len: number }>(`SELECT hlc, ${RECORD_BYTES} AS len FROM changes WHERE key = ?`, c.key)
            .toArray()[0];
          if (cur && cur.hlc >= c.hlc) {
            stale.push(c.key);
            continue;
          }
          delta += c.payload.length + c.key.length + RECORD_OVERHEAD - (cur?.len ?? 0);
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
        if (delta > 0) {
          const used = this.usage();
          if (used.total + delta > limit || used.records + delta > MAX_RECORD_BYTES) throw new StorageFull();
        }
        this.sql.exec("UPDATE usage SET v = v + ? WHERE k = 'records'", delta);
      });
    } catch (e) {
      if (e instanceof StorageFull)
        return { accepted: 0, stale: [], cursor: this.cursor(), usedBytes: this.usage().total, full: true };
      throw e;
    }
    return { accepted, stale, cursor: this.cursor(), usedBytes: this.usage().total };
  }

  /** Changes after `since`, oldest first; `epoch` counts sweeps that deleted files; `usedBytes` the vault's storage. */
  pull(
    since: number,
    limit: number
  ): { changes: StoredChange[]; cursor: number; more: boolean; epoch: number; usedBytes: number } {
    const rows = this.sql
      .exec<StoredChange>(
        "SELECT key, seq, hlc, device, payload FROM changes WHERE seq > ? ORDER BY seq LIMIT ?",
        since,
        limit + 1
      )
      .toArray();
    const more = rows.length > limit;
    const changes = more ? rows.slice(0, limit) : rows;
    return {
      changes,
      cursor: changes.length ? changes[changes.length - 1].seq : since,
      more,
      epoch: this.epoch(),
      usedBytes: this.usage().total,
    };
  }
}
