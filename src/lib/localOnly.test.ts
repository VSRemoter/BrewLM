// "Keep on this device only", end to end: the real schema (db.ts), the real
// push/pull (sync.ts) and apply (syncApply.ts) on sqlite-wasm, against a
// small last-writer-wins server like sync-server's vault.
import sqlite3InitModule, { type Database } from "@sqlite.org/sqlite-wasm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlDb } from "../platform/types";

let raw: Database;

/** plugin-sql's `$1` placeholders, bound by name (as platform/webDbWorker.ts does). */
function binds(sql: string, bind?: unknown[]) {
  if (!bind?.length) return undefined;
  const values = bind.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v === undefined ? null : v));
  if (!/\$\d/.test(sql)) return values;
  const named: Record<string, unknown> = {};
  values.forEach((v, i) => {
    if (new RegExp(`\\$${i + 1}(?!\\d)`).test(sql)) named[`$${i + 1}`] = v;
  });
  return named;
}
const conn = {
  all: <T,>(sql: string, bind?: unknown[]) => raw.selectObjects(sql, binds(sql, bind) as never) as T[],
  run: (sql: string, bind?: unknown[]) => void raw.exec({ sql, bind: binds(sql, bind) as never }),
};
const sqlDb: SqlDb = {
  execute: async (sql, bind) => {
    conn.run(sql, bind);
    return { rowsAffected: raw.changes(), lastInsertId: 0 } as never;
  },
  select: async <T,>(sql: string, bind?: unknown[]) => conn.all(sql, bind) as T,
  close: async () => true,
};

/** The server: one current record per key, newest version wins, a growing seq. */
const server = new Map<string, { hlc: string; payload: string; seq: number }>();
let seq = 0;
/** Its storage plan, in payload characters; a batch that would grow past it is refused whole (like vault.ts). */
let limit = Infinity;
const used = () => [...server.values()].reduce((n, r) => n + r.payload.length, 0);

vi.mock("../platform", async () => {
  const apply = await import("./syncApply");
  return {
    platform: {
      kind: "desktop",
      openDb: async () => sqlDb,
      kv: { get: async () => null, set: async () => {}, delete: async () => {} },
      blobs: { missing: async () => [] },
      sync: {
        log: () => {},
        apply: async (device: string, changes: never) => apply.applyChanges(conn, device, changes),
        markPushed: async (pushed: never) => apply.markPushed(conn, pushed),
      },
      fetch: async (url: string, init: { method?: string; body?: string }) => {
        const path = url.replace(/^.*\/v1\/vaults\/[^/]+\//, "");
        if (path === "push") {
          const { changes } = JSON.parse(init.body!) as { changes: { key: string; hlc: string; payload: string }[] };
          const stale: string[] = [];
          const delta = changes.reduce((n, c) => n + c.payload.length - (server.get(c.key)?.payload.length ?? 0), 0);
          if (delta > 0 && used() + delta > limit) return Response.json({ error: "storage full" }, { status: 413 });
          for (const c of changes) {
            const cur = server.get(c.key);
            if (cur && cur.hlc >= c.hlc) stale.push(c.key);
            else server.set(c.key, { hlc: c.hlc, payload: c.payload, seq: ++seq });
          }
          return Response.json({ accepted: changes.length - stale.length, stale, usedBytes: used() });
        }
        if (path.startsWith("pull")) {
          const since = Number(new URL(url).searchParams.get("since"));
          const changes = [...server.entries()]
            .filter(([, r]) => r.seq > since)
            .sort((a, b) => a[1].seq - b[1].seq)
            .map(([key, r]) => ({ key, hlc: r.hlc, payload: r.payload }));
          return Response.json({ changes, cursor: seq, more: false });
        }
        if (path === "blobs/missing") return Response.json({ missing: [] });
        return new Response("{}", { status: 404 });
      },
    },
  };
});

import { createNotebook, getDb } from "./db";
import { isLocalRow, loadLocalScope, setLocalOnly, syncFootprint } from "./localOnly";
import { cloneNotebook, readSnapshot } from "./share";
import { syncTesting } from "./sync";
import { decryptRecord, deriveKeys, encryptRecord, hiddenId, newVaultKey, type VaultKeys } from "./vaultCrypto";

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PHONE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const cfg = { url: "https://sync.test", token: "t", vault: "v" };
let keys: VaultKeys;
const clock = () => syncTesting.newClock(ME);

beforeAll(async () => {
  const sqlite3 = await sqlite3InitModule();
  raw = new sqlite3.oo1.DB(":memory:");
  keys = await deriveKeys(newVaultKey());
  await getDb(); // the real schema and triggers
});

beforeEach(async () => {
  const d = await getDb();
  for (const t of ["notebooks", "sources", "chats", "messages", "artifacts", "images", "sync_meta", "sync_outbox", "sync_local", "sync_local_gone", "sync_held"])
    await d.execute(`DELETE FROM ${t}`);
  server.clear();
  limit = Infinity;
  await syncTesting.resetFull();
  // A fresh clock: one that saw the "phone" run ahead would outrun later tests' edits.
  clk = clock();
});

/** One cycle; like the real loop, pull and push share this device's clock. */
let clk = clock();
const sync = async () => {
  await syncTesting.pull(cfg, keys, ME, clk, { tables: new Set(), notebookIds: new Set(), chatIds: new Set() });
  await syncTesting.push(cfg, keys, ME, clk);
};

/** What the server holds for a row: its record, or undefined. */
async function onServer(tbl: string, id: string): Promise<{ deleted: boolean; row?: Record<string, unknown> } | undefined> {
  const key = await hiddenId(keys, `${tbl}:${id}`);
  const r = server.get(key);
  return r && JSON.parse(await decryptRecord(keys, key, r.payload));
}

/** Another device's change, put on the server as that device would. */
async function fromPhone(tbl: string, id: string, row: Record<string, unknown> | null) {
  const key = await hiddenId(keys, `${tbl}:${id}`);
  const json = JSON.stringify({ v: 1, tbl, id, deleted: !row, ...(row ? { row } : {}) });
  const hlc = `${String(Date.now() + 1000).padStart(13, "0")}:0000:${PHONE}`;
  server.set(key, { hlc, payload: await encryptRecord(keys, key, json), seq: ++seq });
}

async function addArtifact(id: string, notebookId: string, title = "Out") {
  await (await getDb()).execute(
    "INSERT INTO artifacts (id, notebook_id, kind, title, data, created_at) VALUES ($1, $2, 'report', $3, '{}', 1)",
    [id, notebookId, title]
  );
}

const outbox = async () => (await (await getDb()).select<{ k: string }[]>("SELECT tbl || ':' || row_id AS k FROM sync_outbox")).map((r) => r.k);

describe("keep on this device only", () => {
  it("a notebook created local never reaches the server, nor anything in it", async () => {
    const nb = await createNotebook("Private", "", "", true);
    await addArtifact("a1", nb.id);
    await sync();
    expect(server.size).toBe(0);
    expect(await outbox()).toEqual([]);

    // Edits later still send nothing.
    await (await getDb()).execute("UPDATE artifacts SET title = 'Edited' WHERE id = 'a1'");
    await sync();
    expect(server.size).toBe(0);
  });

  it("marking a synced studio output removes it from the server, and edits after that stay here", async () => {
    const nb = await createNotebook("Shared", "", "");
    await addArtifact("a1", nb.id);
    await addArtifact("a2", nb.id);
    await sync();
    expect((await onServer("artifacts", "a1"))?.row?.title).toBe("Out");

    await setLocalOnly("artifacts", "a1", true);
    await sync();
    expect(await onServer("artifacts", "a1")).toMatchObject({ deleted: true });
    expect((await onServer("artifacts", "a2"))?.row).toBeDefined(); // its neighbour still syncs
    expect((await onServer("notebooks", nb.id))?.row).toBeDefined();

    const before = server.get(await hiddenId(keys, "artifacts:a1"))!.seq;
    await (await getDb()).execute("UPDATE artifacts SET title = 'Edited' WHERE id = 'a1'");
    await sync();
    expect(server.get(await hiddenId(keys, "artifacts:a1"))!.seq).toBe(before); // nothing sent
    expect(await outbox()).toEqual([]);
  });

  it("marking a synced notebook removes it and its contents; unmarking uploads them again", async () => {
    const nb = await createNotebook("Mine", "", "");
    await addArtifact("a1", nb.id);
    await sync();

    await setLocalOnly("notebooks", nb.id, true);
    await sync();
    expect(await onServer("notebooks", nb.id)).toMatchObject({ deleted: true });
    expect(await onServer("artifacts", "a1")).toMatchObject({ deleted: true });
    // Still here.
    expect(await (await getDb()).select<unknown[]>("SELECT id FROM artifacts WHERE id = 'a1'")).toHaveLength(1);

    await setLocalOnly("notebooks", nb.id, false);
    await sync();
    expect((await onServer("notebooks", nb.id))?.row?.title).toBe("Mine");
    expect((await onServer("artifacts", "a1"))?.row?.title).toBe("Out");
    expect((await (await getDb()).select<unknown[]>("SELECT * FROM sync_local_gone"))).toHaveLength(0);
  });

  it("another device's deletion doesn't remove a local item here", async () => {
    const nb = await createNotebook("Mine", "", "");
    await addArtifact("a1", nb.id);
    await sync();
    await setLocalOnly("artifacts", "a1", true);
    await sync();

    await fromPhone("artifacts", "a1", null);
    await sync();
    expect(await (await getDb()).select<unknown[]>("SELECT id FROM artifacts WHERE id = 'a1'")).toHaveLength(1);
  });

  it("another device's edit to a local item is taken here, and its copy is left alone on the server", async () => {
    const nb = await createNotebook("Mine", "", "");
    await addArtifact("a1", nb.id);
    await sync();
    await setLocalOnly("notebooks", nb.id, true);
    await sync();

    // Another device sends it again (it hadn't heard, or synced it again on
    // purpose). Removing it once more could make that device delete its copy.
    await fromPhone("artifacts", "a1", { id: "a1", notebook_id: nb.id, kind: "report", title: "From phone", data: "{}", created_at: 1 });
    await sync();
    const here = await (await getDb()).select<{ title: string }[]>("SELECT title FROM artifacts WHERE id = 'a1'");
    expect(here[0].title).toBe("From phone");
    expect((await onServer("artifacts", "a1"))?.row?.title).toBe("From phone");

    // And this device's own edits still send nothing.
    const at = server.get(await hiddenId(keys, "artifacts:a1"))!.seq;
    await (await getDb()).execute("UPDATE artifacts SET title = 'Mine again' WHERE id = 'a1'");
    await sync();
    expect(server.get(await hiddenId(keys, "artifacts:a1"))!.seq).toBe(at);
  });

  it("a copy of a notebook keeps its local marks: the notebook's, and single items'", async () => {
    const local = await createNotebook("Private", "", "", true);
    await addArtifact("a1", local.id);
    const synced = await createNotebook("Mixed", "", "");
    await addArtifact("a2", synced.id, "Private output");
    await addArtifact("a3", synced.id, "Public output");
    await setLocalOnly("artifacts", "a2", true);

    const copy1 = await cloneNotebook(local.id, "Private (copy)", { includeChats: false });
    const copy2 = await cloneNotebook(synced.id, "Mixed (copy)", { includeChats: false });
    await sync();
    expect(await onServer("notebooks", copy1.id)).toBeUndefined();
    expect((await onServer("notebooks", copy2.id))?.row).toBeDefined();
    const titles = await Promise.all(
      (await (await getDb()).select<{ id: string; title: string }[]>("SELECT id, title FROM artifacts WHERE notebook_id = $1", [copy2.id])).map(
        async (a) => [a.title, (await onServer("artifacts", a.id))?.row !== undefined] as const
      )
    );
    expect(Object.fromEntries(titles)).toEqual({ "Private output": false, "Public output": true });
  });

  it("a shared link leaves out single items kept on this device", async () => {
    const nb = await createNotebook("Mixed", "", "");
    await addArtifact("a2", nb.id, "Private output");
    await addArtifact("a3", nb.id, "Public output");
    await setLocalOnly("artifacts", "a2", true);
    const snap = await readSnapshot(nb.id, { leaveOutLocal: true });
    expect(snap.artifacts.map((a) => a.title)).toEqual(["Public output"]);
    // A plain copy still has everything.
    expect((await readSnapshot(nb.id)).artifacts).toHaveLength(2);
  });

  it("measures what syncing an item again would send, without items that stay local", async () => {
    const nb = await createNotebook("Private", "", "", true);
    await addArtifact("a1", nb.id, "Big");
    await addArtifact("a2", nb.id, "Still private");
    await setLocalOnly("artifacts", "a2", true);
    await (await getDb()).execute("UPDATE artifacts SET data = $1 WHERE id = 'a1'", [`{"audio":"brewblob:${"f".repeat(64)}.m4a"}`]);
    const fp = await syncFootprint("notebooks", nb.id);
    expect(fp.files).toEqual([`${"f".repeat(64)}.m4a`]);
    const withBoth = fp.recordChars;
    await setLocalOnly("artifacts", "a2", false);
    expect((await syncFootprint("notebooks", nb.id)).recordChars).toBeGreaterThan(withBoth);
  });

  it("storage full: deletions and what fits still go; the rest waits instead of stalling", async () => {
    const nb = await createNotebook("Synced", "", "");
    await addArtifact("old", nb.id, "Old");
    await sync();
    limit = used() + 200; // room for a little more, not for a big record
    await addArtifact("big", nb.id, "x".repeat(5000));
    await (await getDb()).execute("DELETE FROM artifacts WHERE id = 'old'");
    await expect(sync()).resolves.toBeUndefined(); // no error: the cycle carries on

    expect(syncTesting.isStorageFull()).toBe(true);
    expect(await onServer("artifacts", "old")).toMatchObject({ deleted: true }); // the deletion went
    expect(await onServer("artifacts", "big")).toBeUndefined(); // the big one waits...
    expect(await outbox()).toContain("artifacts:big"); // ...in the outbox

    // A small edit elsewhere still syncs while the big one waits.
    await addArtifact("small", nb.id, "s");
    await sync();
    expect((await onServer("artifacts", "small"))?.row).toBeDefined();

    // Room again (a bigger plan): it goes up.
    limit = Infinity;
    await syncTesting.resetFull();
    await sync();
    expect((await onServer("artifacts", "big"))?.row).toBeDefined();
    expect(await outbox()).toEqual([]);
  });

  it("deleting a local item sends nothing", async () => {
    const nb = await createNotebook("Private", "", "", true);
    await addArtifact("a1", nb.id);
    await sync();
    await (await getDb()).execute("DELETE FROM artifacts WHERE id = 'a1'");
    await (await getDb()).execute("DELETE FROM notebooks WHERE id = $1", [nb.id]);
    await sync();
    expect(server.size).toBe(0);
  });

  it("an ordinary synced item that's deleted is still deleted on the server", async () => {
    const nb = await createNotebook("Synced", "", "");
    await addArtifact("a1", nb.id);
    await sync();
    await (await getDb()).execute("DELETE FROM artifacts WHERE id = 'a1'");
    await sync();
    expect(await onServer("artifacts", "a1")).toMatchObject({ deleted: true });
  });

  it("a local chat covers its messages", async () => {
    const scope = await loadLocalScope();
    scope.chats.add("c1");
    expect(isLocalRow(scope, "messages", "m1", { chat_id: "c1", notebook_id: "n" })).toBe(true);
    expect(isLocalRow(scope, "messages", "m2", { chat_id: "c2", notebook_id: "n" })).toBe(false);
    expect(isLocalRow(scope, "images", "i1", { chat_id: "c1", notebook_id: "n" })).toBe(true);
  });
});
