/**
 * BrewLM Sync engine — milestones 2a–2b: records and media, a dev server, polling.
 *
 * Every few seconds: PULL changes other devices made (server `seq` after our
 * cursor) and apply them through Rust in one transaction (src-tauri/src/sync.rs,
 * which also settles conflicts), then PUSH rows the change-tracking triggers
 * put in `sync_outbox` (db.ts). Pulling first means a conflicting edit made
 * elsewhere is seen before ours goes out.
 *
 * Versions are hybrid logical clocks — `<ms>:<counter>:<device id>` strings
 * that sort as text: wall-clock time, kept ahead of every version this device
 * has seen so a slow clock can't make new edits look old. Last writer wins
 * per row.
 *
 * Each record travels as an opaque payload `{ v, tbl, id, deleted, row }`
 * under the key `tbl:id`; milestone 2c encrypts both. A record too big for the
 * change log is uploaded as a blob and its payload becomes `{ v, blob }`.
 *
 * Media files (audio, images, covers) are blobs named by their content hash,
 * so they upload once and every download is checked against its name. Rows
 * may arrive before their files: missing files are fetched as they appear,
 * and images re-render once their file lands (`markArrived`).
 *
 * Milestone 2a reads its server settings from the environment of a dev build
 * (`BREWLM_SYNC_URL`, `BREWLM_SYNC_TOKEN`, `BREWLM_SYNC_VAULT`); accounts and
 * a Settings page come with milestone 2e.
 */
import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { load } from "@tauri-apps/plugin-store";
import { BLOB_PREFIX, blobRefsIn, markArrived, mediaBytes, putBlob } from "./blobs";
import { getDb, referencedBlobRefs, SYNCED_TABLES, uid } from "./db";

interface SyncConfig {
  url: string;
  token: string;
  vault: string;
}

interface Payload {
  v: 1;
  tbl: string;
  id: string;
  deleted: boolean;
  row?: Record<string, unknown>;
  /** Set instead of the fields above when the record was stored as a blob. */
  blob?: string;
}

/** What a pull changed, for views that need to reload. */
export interface RemoteChanges {
  tables: Set<string>;
  notebookIds: Set<string>;
  chatIds: Set<string>;
}

const POLL_MS = 3000;
const MAX_BACKOFF_MS = 60_000;
const PUSH_BATCH = 200;
/** Records above this travel as blobs (the server's change-log cap is 1.5M chars). */
const MAX_INLINE = 1_000_000;
/** Larger than any real row; such a record is kept local and logged. */
const MAX_RECORD = 50_000_000;
/** Tables whose rows can point at media files (refresh views when files land). */
const MEDIA_TABLES = ["notebooks", "folders", "sources", "images", "artifacts", "messages"];
/** A file another device hasn't uploaded yet is retried this often. */
const DOWNLOAD_RETRY_MS = 30_000;

/** Settings that describe this machine, never another device. */
const LOCAL_SETTINGS = new Set(["localBaseUrl", "localKey", "localContext", "localEmbedModel", "customModels.local"]);
const LOCAL_SETTING_PREFIXES = ["condense."]; // per-notebook caches, rebuilt on demand
const API_KEY_SETTINGS = new Set([
  "anthropicKey",
  "openaiKey",
  "openaiTtsKey",
  "openrouterKey",
  "openrouterTtsKey",
  "elevenlabsKey",
]);

/* --------------------------------- state --------------------------------- */

async function getState(key: string): Promise<string> {
  const d = await getDb();
  const rows = await d.select<{ value: string }[]>("SELECT value FROM sync_state WHERE key = $1", [key]);
  return rows[0]?.value ?? "";
}

async function setState(key: string, value: string): Promise<void> {
  const d = await getDb();
  await d.execute(
    "INSERT INTO sync_state (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2",
    [key, value]
  );
}

/**
 * This install's device id lives outside the database, so a database that
 * arrived from elsewhere (a restored backup, a copied folder) is noticed: it
 * adopts this install's id and re-pulls from the start, and last-writer-wins
 * decides, row by row, which version is newer.
 */
async function deviceId(): Promise<string> {
  const store = await load("sync-device.json", { autoSave: false, defaults: {} });
  let id = await store.get<string>("deviceId");
  if (!id) {
    id = uid();
    await store.set("deviceId", id);
    await store.save();
  }
  if ((await getState("device_id")) !== id) {
    await setState("device_id", id);
    await setState("cursor", "0");
  }
  return id;
}

/* ------------------------------ clock (HLC) ------------------------------ */

const pad = (n: number, w: number) => String(n).padStart(w, "0");

class Clock {
  constructor(
    private device: string,
    private ms = 0,
    private counter = 0
  ) {}

  static parse(device: string, last: string): Clock {
    const [ms, counter] = last.split(":").map(Number);
    return new Clock(device, ms || 0, counter || 0);
  }

  /** A version newer than anything seen, and no older than `atLeastMs`. */
  next(atLeastMs: number): string {
    const ms = Math.max(Date.now(), atLeastMs);
    if (ms > this.ms) {
      this.ms = ms;
      this.counter = 0;
    } else if (++this.counter > 9999) {
      this.ms += 1;
      this.counter = 0;
    }
    return `${pad(this.ms, 13)}:${pad(this.counter, 4)}:${this.device}`;
  }

  /** Keep our next versions ahead of one seen from another device. */
  observe(hlc: string): void {
    const [ms, counter] = hlc.split(":").map(Number);
    if (ms > this.ms || (ms === this.ms && counter > this.counter)) {
      this.ms = ms;
      this.counter = counter;
    }
  }

  toString(): string {
    return `${this.ms}:${this.counter}`;
  }
}

/** Log to the console and the launching terminal (see `sync_log`). */
function log(line: string, warn = false): void {
  (warn ? console.warn : console.info)(`sync: ${line}`);
  void invoke("sync_log", { line }).catch(() => {});
}

/* --------------------------------- server -------------------------------- */

async function api<T>(cfg: SyncConfig, path: string, body?: unknown): Promise<T> {
  const res = await tauriFetch(`${cfg.url.replace(/\/$/, "")}/v1/vaults/${cfg.vault}/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    connectTimeout: 15000,
  });
  if (!res.ok) throw new Error(`sync server: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

function blobUrl(cfg: SyncConfig, id: string): string {
  return `${cfg.url.replace(/\/$/, "")}/v1/vaults/${cfg.vault}/blobs/${encodeURIComponent(id)}`;
}

async function putRemoteBlob(cfg: SyncConfig, id: string, bytes: Uint8Array): Promise<void> {
  const res = await tauriFetch(blobUrl(cfg, id), {
    method: "PUT",
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/octet-stream" },
    body: bytes,
    connectTimeout: 15000,
  });
  if (!res.ok) throw new Error(`sync server: upload ${id}: HTTP ${res.status}`);
}

/** The blob's bytes, or null if the server doesn't have it (yet). */
async function getRemoteBlob(cfg: SyncConfig, id: string): Promise<Uint8Array | null> {
  const res = await tauriFetch(blobUrl(cfg, id), {
    headers: { authorization: `Bearer ${cfg.token}` },
    connectTimeout: 15000,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`sync server: download ${id}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function syncsSetting(key: string, syncKeys: boolean): boolean {
  if (LOCAL_SETTINGS.has(key) || LOCAL_SETTING_PREFIXES.some((p) => key.startsWith(p))) return false;
  return syncKeys || !API_KEY_SETTINGS.has(key);
}

/* ---------------------------------- pull --------------------------------- */

async function pull(cfg: SyncConfig, device: string, clock: Clock, out: RemoteChanges): Promise<void> {
  const syncKeys = (await getState("sync_api_keys")) !== "0";
  let cursor = Number((await getState("cursor")) || "0");
  for (;;) {
    const res = await api<{
      changes: { key: string; hlc: string; payload: string }[];
      cursor: number;
      more: boolean;
    }>(cfg, `pull?since=${cursor}&limit=500`);
    const batch: { tbl: string; row_id: string; hlc: string; deleted: boolean; row?: Record<string, unknown> }[] = [];
    for (const c of res.changes) {
      clock.observe(c.hlc);
      let p: Payload;
      try {
        p = JSON.parse(c.payload);
        if (p.blob) {
          const bytes = await getRemoteBlob(cfg, p.blob);
          if (!bytes) throw new Error(`record blob ${p.blob} is missing`);
          p = JSON.parse(new TextDecoder().decode(bytes));
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e; // network trouble: retry the whole page next cycle
      }
      if (p.v !== 1 || !(p.tbl in SYNCED_TABLES)) continue; // from a newer app version
      if (p.tbl === "settings" && !syncsSetting(p.id, syncKeys)) continue;
      batch.push({ tbl: p.tbl, row_id: p.id, hlc: c.hlc, deleted: p.deleted, row: p.row });
    }
    if (batch.length > 0) {
      const { applied } = await invoke<{ applied: number[] }>("sync_apply", { deviceId: device, changes: batch });
      for (const i of applied) {
        const { tbl, row_id, row } = batch[i];
        out.tables.add(tbl);
        if (tbl === "notebooks") out.notebookIds.add(row_id);
        if (tbl === "chats") out.chatIds.add(row_id);
        if (typeof row?.notebook_id === "string") out.notebookIds.add(row.notebook_id);
        if (typeof row?.chat_id === "string") out.chatIds.add(row.chat_id);
        if (row) for (const ref of blobRefsIn(JSON.stringify(row))) media.wanted.add(ref.slice(BLOB_PREFIX.length));
      }
    }
    cursor = res.cursor;
    await setState("cursor", String(cursor));
    if (!res.more) return;
  }
}

/* ---------------------------------- push --------------------------------- */

/** Rows too big to send at all (kept in the outbox and logged once). */
const oversized = new Set<string>();

/** Push the outbox; returns how many records the server accepted. */
async function push(cfg: SyncConfig, device: string, clock: Clock): Promise<number> {
  const d = await getDb();
  const syncKeys = (await getState("sync_api_keys")) !== "0";
  let accepted = 0;
  for (;;) {
    const skip = [...oversized];
    const entries = await d.select<{ tbl: string; row_id: string; changed_at: number }[]>(
      `SELECT tbl, row_id, changed_at FROM sync_outbox
       ${skip.length ? `WHERE (tbl || ':' || row_id) NOT IN (${skip.map((_, i) => `$${i + 1}`).join(", ")})` : ""}
       ORDER BY changed_at LIMIT ${PUSH_BATCH}`,
      skip
    );
    if (entries.length === 0) return accepted;

    // Current rows, per table (a missing row means it was deleted).
    const rows = new Map<string, Record<string, unknown>>();
    for (const tbl of new Set(entries.map((e) => e.tbl))) {
      const pk = SYNCED_TABLES[tbl];
      if (!pk) continue;
      const ids = entries.filter((e) => e.tbl === tbl).map((e) => e.row_id);
      const found = await d.select<Record<string, unknown>[]>(
        `SELECT * FROM ${tbl} WHERE ${pk} IN (${ids.map((_, i) => `$${i + 1}`).join(", ")})`,
        ids
      );
      for (const r of found) rows.set(`${tbl}:${r[pk]}`, r);
    }

    const changes: { key: string; hlc: string; payload: string }[] = [];
    const sent: { tbl: string; row_id: string; changed_at: number; hlc: string | null }[] = [];
    for (const e of entries) {
      const key = `${e.tbl}:${e.row_id}`;
      if (!SYNCED_TABLES[e.tbl] || (e.tbl === "settings" && !syncsSetting(e.row_id, syncKeys))) {
        sent.push({ ...e, hlc: null }); // never leaves this device: just clear it
        continue;
      }
      const row = rows.get(key);
      let payload = JSON.stringify({ v: 1, tbl: e.tbl, id: e.row_id, deleted: !row, ...(row ? { row } : {}) });
      if (payload.length > MAX_RECORD) {
        if (!oversized.has(key)) log(`${key} is too large to sync (${payload.length} chars)`, true);
        oversized.add(key);
        continue;
      }
      for (const ref of blobRefsIn(payload)) media.toUpload.add(ref.slice(BLOB_PREFIX.length));
      if (payload.length > MAX_INLINE) {
        const bytes = new TextEncoder().encode(payload);
        const id = `rec-${await sha256Hex(bytes)}`;
        await putRemoteBlob(cfg, id, bytes);
        payload = JSON.stringify({ v: 1, blob: id });
      }
      const hlc = clock.next(e.changed_at);
      changes.push({ key, hlc, payload });
      sent.push({ ...e, hlc });
    }

    // Files first, so a device that pulls these rows can fetch what they point at.
    await uploadMedia(cfg);
    if (changes.length > 0) {
      const res = await api<{ accepted: number; stale: string[] }>(cfg, "push", { device, changes });
      accepted += res.accepted;
      // Stale = the server already holds a newer version; drop ours (it lost).
      const stale = new Set(res.stale);
      for (const s of sent) if (stale.has(`${s.tbl}:${s.row_id}`)) s.hlc = null;
    }
    await invoke("sync_mark_pushed", { pushed: sent });
    await setState("hlc_last", clock.toString());
  }
}

/* ---------------------------------- media -------------------------------- */

const media = {
  /** The first cycle compares every file rows point at with this device and the server. */
  scanned: false,
  /** Files the server is known to have. */
  onServer: new Set<string>(),
  /** Local files to make sure the server has. */
  toUpload: new Set<string>(),
  /** Files rows point at; downloaded if this device lacks them. */
  wanted: new Set<string>(),
  /** Files the server didn't have yet → when to ask again. */
  retryAt: new Map<string, number>(),
  /** Files uploaded this session (for the activity log). */
  uploaded: 0,
};

async function scanMedia(): Promise<void> {
  const names = (await referencedBlobRefs()).map((r) => r.slice(BLOB_PREFIX.length));
  const absent = new Set(await invoke<string[]>("blob_missing", { names }));
  for (const n of names) (absent.has(n) ? media.wanted : media.toUpload).add(n);
  media.scanned = true;
}

/** Upload files the server lacks. */
async function uploadMedia(cfg: SyncConfig): Promise<void> {
  // Each file leaves the queue only once it's settled, so an error keeps the rest.
  for (const n of media.toUpload) if (media.onServer.has(n)) media.toUpload.delete(n);
  const pending = [...media.toUpload];
  for (let i = 0; i < pending.length; i += 1000) {
    const ids = pending.slice(i, i + 1000);
    const { missing } = await api<{ missing: string[] }>(cfg, "blobs/missing", { ids });
    const need = new Set(missing);
    for (const id of ids) {
      if (!need.has(id)) {
        media.onServer.add(id);
        media.toUpload.delete(id);
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = await mediaBytes(`${BLOB_PREFIX}${id}`);
      } catch {
        media.toUpload.delete(id);
        media.wanted.add(id); // not on this device either: maybe another one has it
        continue;
      }
      await putRemoteBlob(cfg, id, bytes);
      media.onServer.add(id);
      media.toUpload.delete(id);
      media.uploaded += 1;
    }
  }
}

/** Download files rows point at that this device lacks; returns how many landed. */
async function downloadMedia(cfg: SyncConfig): Promise<number> {
  if (media.wanted.size === 0) return 0;
  const now = Date.now();
  const due = [...media.wanted].filter((n) => (media.retryAt.get(n) ?? 0) <= now);
  const absent = new Set(await invoke<string[]>("blob_missing", { names: due }));
  let landed = 0;
  for (const name of due) {
    if (!absent.has(name)) {
      media.wanted.delete(name); // already here
      continue;
    }
    const bytes = await getRemoteBlob(cfg, name);
    if (!bytes) {
      media.retryAt.set(name, now + DOWNLOAD_RETRY_MS);
      continue;
    }
    const ext = name.slice(name.lastIndexOf(".") + 1);
    const ref = await putBlob(bytes, ext);
    media.wanted.delete(name);
    media.retryAt.delete(name);
    if (ref !== `${BLOB_PREFIX}${name}`) {
      log(`file ${name} arrived damaged (its contents don't match its name) — skipped`, true);
      continue;
    }
    media.onServer.add(name);
    markArrived(name);
    landed += 1;
  }
  return landed;
}

/* ---------------------------------- loop --------------------------------- */

const listeners = new Set<(c: RemoteChanges) => void>();

/** Subscribe to changes pulled from other devices; returns an unsubscribe. */
export function onRemoteChanges(fn: (c: RemoteChanges) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

let started = false;
let stopped = false;

// Dev: hot-swapping this module would leave views subscribed to the old copy
// while a new loop starts, so stop the old loop and reload the whole page.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stopped = true;
  });
  import.meta.hot.accept(() => window.location.reload());
}

/** Start syncing if this build has a sync server configured (dev builds, for now). */
export async function startSync(): Promise<void> {
  if (started) return;
  const cfg = await invoke<SyncConfig | null>("sync_dev_config");
  if (!cfg) return;
  started = true;
  const device = await deviceId();
  const clock = Clock.parse(device, await getState("hlc_last"));
  log(`on — ${cfg.url}, vault "${cfg.vault}", device ${device.slice(0, 8)}`);

  let delay = POLL_MS;
  const cycle = async () => {
    if (stopped) return;
    const changed: RemoteChanges = { tables: new Set(), notebookIds: new Set(), chatIds: new Set() };
    try {
      await pull(cfg, device, clock, changed);
      if (!media.scanned) await scanMedia();
      const landed = await downloadMedia(cfg);
      if (landed > 0) for (const t of MEDIA_TABLES) changed.tables.add(t);
      const before = media.uploaded;
      const sent = await push(cfg, device, clock);
      await uploadMedia(cfg); // files from the first scan, or left over from a failed cycle
      const uploaded = media.uploaded - before;
      if (changed.tables.size > 0 || sent > 0 || uploaded > 0)
        log(
          `pulled changes to ${[...changed.tables].join(", ") || "nothing"}; pushed ${sent}` +
            (landed || uploaded ? `; files: ${landed} down, ${uploaded} up` : "")
        );
      delay = POLL_MS;
    } catch (e) {
      delay = Math.min(delay * 2, MAX_BACKOFF_MS);
      log(`${e instanceof Error ? e.message : String(e)} — retrying in ${delay / 1000}s`, true);
    }
    if (changed.tables.size > 0) for (const fn of listeners) fn(changed);
    setTimeout(cycle, delay);
  };
  void cycle();
}
