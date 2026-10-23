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

  private cursor(): number {
    return (this.sql.exec<{ s: number | null }>("SELECT max(seq) AS s FROM changes").one().s ?? 0) as number;
  }

  /** Store changes that are newer than what the vault holds; report the rest as stale. */
  push(device: string, changes: Change[]): { accepted: number; stale: string[]; cursor: number } {
    const stale: string[] = [];
    let accepted = 0;
    this.ctx.storage.transactionSync(() => {
      let seq = this.cursor();
      for (const c of changes) {
        const cur = this.sql.exec<{ hlc: string }>("SELECT hlc FROM changes WHERE key = ?", c.key).toArray()[0];
        if (cur && cur.hlc >= c.hlc) {
          stale.push(c.key);
          continue;
        }
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
    });
    return { accepted, stale, cursor: this.cursor() };
  }

  /** Changes after `since`, oldest first. */
  pull(since: number, limit: number): { changes: StoredChange[]; cursor: number; more: boolean } {
    const rows = this.sql
      .exec<StoredChange>(
        "SELECT key, seq, hlc, device, payload FROM changes WHERE seq > ? ORDER BY seq LIMIT ?",
        since,
        limit + 1
      )
      .toArray();
    const more = rows.length > limit;
    const changes = more ? rows.slice(0, limit) : rows;
    return { changes, cursor: changes.length ? changes[changes.length - 1].seq : since, more };
  }
}
