/**
 * "Keep on this device only": notebooks, sources, chats and studio outputs
 * Sync never uploads.
 *
 * The choice lives in `sync_local` (db.ts), a table that isn't synced itself.
 * A marked notebook covers everything in it; a marked chat covers its
 * messages and images. Notebooks opened from someone's shared link count as
 * local too (they always have).
 *
 * How Sync treats a local row (sync.ts):
 * - push: never sent. If the item synced before it was marked, a deletion is
 *   sent once instead, which takes it off the server and the other devices;
 *   the row is then listed in `sync_local_gone` so later edits send nothing.
 * - pull: another device's deletion is ignored (this device keeps its copy).
 *   Another device's edit (one that hadn't heard, or that synced it again on
 *   purpose) is applied here and left on the server: removing it again could
 *   make that device delete its own copy.
 *
 * Turning it back on queues the item and everything in it, so the next push
 * uploads them as new versions.
 */
import { BLOB_PREFIX, blobRefsIn } from "./blobs";
import { getDb } from "./db";

/** What can be marked, and the rows each one covers. */
export type LocalItemTable = "notebooks" | "sources" | "chats" | "artifacts";

const COVERS: Record<LocalItemTable, { tbl: string; pk: string; where: string }[]> = {
  notebooks: [
    { tbl: "notebooks", pk: "id", where: "id = $1" },
    { tbl: "sources", pk: "id", where: "notebook_id = $1" },
    { tbl: "chats", pk: "id", where: "notebook_id = $1" },
    { tbl: "messages", pk: "id", where: "notebook_id = $1" },
    { tbl: "artifacts", pk: "id", where: "notebook_id = $1" },
    { tbl: "images", pk: "id", where: "notebook_id = $1" },
    { tbl: "shares", pk: "id", where: "notebook_id = $1" },
  ],
  chats: [
    { tbl: "chats", pk: "id", where: "id = $1" },
    { tbl: "messages", pk: "id", where: "chat_id = $1" },
    { tbl: "images", pk: "id", where: "chat_id = $1" },
  ],
  sources: [{ tbl: "sources", pk: "id", where: "id = $1" }],
  artifacts: [{ tbl: "artifacts", pk: "id", where: "id = $1" }],
};

/** Which rows stay on this device, loaded once per sync batch. */
export interface LocalScope {
  /** Notebooks kept local: marked, or opened from a shared link. */
  notebooks: Set<string>;
  /** Chats marked local. */
  chats: Set<string>;
  /** Every mark, as `tbl:id`. */
  marked: Set<string>;
  /** Local rows with no live copy on the server, as `tbl:id`. */
  gone: Set<string>;
}

export async function loadLocalScope(): Promise<LocalScope> {
  const d = await getDb();
  const marks = await d.select<{ tbl: string; row_id: string }[]>("SELECT tbl, row_id FROM sync_local");
  const shared = await d.select<{ id: string }[]>("SELECT id FROM notebooks WHERE share_id != ''");
  const gone = await d.select<{ k: string }[]>("SELECT tbl || ':' || row_id AS k FROM sync_local_gone");
  return {
    notebooks: new Set([
      ...marks.filter((m) => m.tbl === "notebooks").map((m) => m.row_id),
      ...shared.map((r) => r.id),
    ]),
    chats: new Set(marks.filter((m) => m.tbl === "chats").map((m) => m.row_id)),
    marked: new Set(marks.map((m) => `${m.tbl}:${m.row_id}`)),
    gone: new Set(gone.map((r) => r.k)),
  };
}

/** Whether a row (as stored here, or as another device sent it) stays on this device. */
export function isLocalRow(scope: LocalScope, tbl: string, id: string, row: Record<string, unknown> | undefined): boolean {
  if (scope.marked.has(`${tbl}:${id}`)) return true;
  if (tbl === "notebooks") return scope.notebooks.has(id);
  if (!row) return false;
  if (typeof row.notebook_id === "string" && scope.notebooks.has(row.notebook_id)) return true;
  if ((tbl === "messages" || tbl === "images") && typeof row.chat_id === "string" && scope.chats.has(row.chat_id))
    return true;
  return false;
}

/**
 * What syncing this item again would send: its records' size (characters of
 * JSON) and the files they point at. Rows that stay local anyway (an item
 * marked inside a notebook being synced) are left out.
 */
export async function syncFootprint(tbl: LocalItemTable, id: string): Promise<{ recordChars: number; files: string[] }> {
  const d = await getDb();
  const scope = await loadLocalScope();
  // As it will be once unmarked.
  scope.marked.delete(`${tbl}:${id}`);
  if (tbl === "notebooks") scope.notebooks.delete(id);
  if (tbl === "chats") scope.chats.delete(id);
  let recordChars = 0;
  const files = new Set<string>();
  for (const c of COVERS[tbl]) {
    // In pages: a big notebook's rows shouldn't all sit in memory at once.
    for (let offset = 0; ; offset += 500) {
      const rows = await d.select<Record<string, unknown>[]>(
        `SELECT * FROM ${c.tbl} WHERE ${c.where} LIMIT 500 OFFSET ${offset}`,
        [id]
      );
      for (const r of rows) {
        if (isLocalRow(scope, c.tbl, String(r[c.pk]), r)) continue;
        const json = JSON.stringify(r);
        recordChars += json.length;
        for (const ref of blobRefsIn(json)) files.add(ref.slice(BLOB_PREFIX.length));
      }
      if (rows.length < 500) break;
    }
  }
  return { recordChars, files: [...files] };
}

/* ------------------------------ the switch ------------------------------ */

const listeners = new Set<() => void>();

/** Called whenever something is marked or unmarked. Returns an unsubscribe. */
export function onLocalOnlyChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Every mark, as `tbl:id` (for badges and toggles), plus notebooks from a
 * shared link as `shared:id` (local anyway, so their items get no toggle).
 */
export async function localOnlyMarks(): Promise<Set<string>> {
  const d = await getDb();
  const rows = await d.select<{ k: string }[]>(
    "SELECT tbl || ':' || row_id AS k FROM sync_local UNION ALL SELECT 'shared:' || id FROM notebooks WHERE share_id != ''"
  );
  return new Set(rows.map((r) => r.k));
}

/** Settings → Sync: whether new notebooks start out on this device only (this device's choice). */
export async function newNotebooksLocal(): Promise<boolean> {
  const d = await getDb();
  const rows = await d.select<{ value: string }[]>("SELECT value FROM sync_state WHERE key = 'new_notebooks_local'");
  return rows[0]?.value === "1";
}

export async function setNewNotebooksLocal(on: boolean): Promise<void> {
  const d = await getDb();
  await d.execute(
    "INSERT INTO sync_state (key, value) VALUES ('new_notebooks_local', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [on ? "1" : "0"]
  );
}

/**
 * Keep an item on this device only, or let it sync again. Either way the
 * item and everything in it is queued, so the next sync cycle removes its
 * server copy (and other devices' copies) or uploads it.
 */
export async function setLocalOnly(tbl: LocalItemTable, id: string, on: boolean): Promise<void> {
  const d = await getDb();
  if (on) await d.execute("INSERT OR IGNORE INTO sync_local (tbl, row_id) VALUES ($1, $2)", [tbl, id]);
  else await d.execute("DELETE FROM sync_local WHERE tbl = $1 AND row_id = $2", [tbl, id]);
  const now = Date.now();
  for (const c of COVERS[tbl]) {
    await d.execute(
      `INSERT INTO sync_outbox (tbl, row_id, changed_at)
       SELECT '${c.tbl}', ${c.pk}, $2 FROM ${c.tbl} WHERE ${c.where}
       ON CONFLICT (tbl, row_id) DO UPDATE SET changed_at = excluded.changed_at`,
      [id, now]
    );
  }
  for (const fn of listeners) fn();
}
