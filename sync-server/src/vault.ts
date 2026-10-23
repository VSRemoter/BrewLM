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
