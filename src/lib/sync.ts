/**
 * BrewLM Sync engine — milestones 2a–2c: end-to-end encrypted records and
 * media, a dev server, polling.
 *
 * A sync cycle PULLS changes other devices made (server `seq` after our
 * cursor) and applies them in one transaction (src-tauri/src/sync.rs on desktop,
 * syncApply.ts on the web; both settle conflicts the same way), then PUSHES rows the change-tracking triggers
 * put in `sync_outbox` (db.ts). Pulling first means a conflicting edit made
 * elsewhere is seen before ours goes out. A cycle runs as soon as there's
 * something to upload (the outbox is checked locally every few seconds), and
 * otherwise every 30 s or when the window regains focus, to pick up other
 * devices' changes without a constant stream of requests.
 *
 * Versions are hybrid logical clocks — `<ms>:<counter>:<device id>` strings
 * that sort as text: wall-clock time, kept ahead of every version this device
 * has seen so a slow clock can't make new edits look old. Last writer wins
 * per row.
 *
 * Everything leaves the device encrypted with the vault key (vaultCrypto.ts):
 * a record `{ v, tbl, id, deleted, row }` is stored under a hidden id of
 * `tbl:id`; one too big for the change log is uploaded as an encrypted blob
 * and its record becomes `{ v, blob }`. Media files are blobs under a hidden
 * id of their content-hash name; every download is decrypted and checked
 * against that name. Rows may arrive before their files: missing files are
 * fetched as they appear, and images re-render once theirs lands.
 *
 * The vault key is kept in this install's `sync-device.json`, outside the
 * database, so it never ends up in a backup. Settings → Sync signs in by email
 * (an account = one vault, with a trial or a plan), then sets up or unlocks
 * the vault (password, recovery key, or a link code from a signed-in device —
 * see `startDeviceLink`). Without an active plan the account is read-only:
 * this device keeps pulling but doesn't upload.
 *
 * Release builds sync with https://sync.brewlm.com. Dev builds use
 * `BREWLM_SYNC_URL` (none = sync off); `BREWLM_SYNC_TOKEN` (+ `_VAULT`,
 * `_PASSWORD`) skips accounts for the two-copy dev setup.
 */
import { platform } from "../platform";
import { BLOB_PREFIX, blobRefsIn, markArrived, mediaBytes, putBlob } from "./blobs";
import { getDb, referencedBlobRefs, SYNCED_TABLES, uid } from "./db";
import {
  createEnvelope,
  decryptBlob,
  decryptRecord,
  deriveKeys,
  encryptBlob,
  encryptRecord,
  type Envelope,
  formatLinkCode,
  formatRecoveryKey,
  fromBase64,
  hiddenId,
  linkId,
  linkUri,
  newLinkSecret,
  openLink,
  parseLink,
  sealForLink,
  newRecoveryKey,
  newVaultKey,
  rewrapPassword,
  rewrapRecovery,
  toBase64,
  unlockWithPassword,
  unlockWithRecovery,
  type VaultKeys,
} from "./vaultCrypto";

interface SyncConfig {
  url: string;
  /** A session token after sign-in (or the dev token). */
  token: string;
  vault: string;
  /** Dev only: set up or unlock with this password, without the UI. */
  password?: string | null;
}

/** What the build provides: the server, and (dev) a shared token instead of an account. */
interface ServerConfig {
  url: string;
  token?: string | null;
  vault?: string;
  password?: string | null;
}

/** The signed-in account, kept in sync-device.json. */
interface Account {
  session: string;
  email: string;
  vault: string;
}

/** From GET /v1/me. */
export interface AccountInfo {
  email: string;
  plan: "trial" | "sync" | "plus" | "none";
  /** False when the trial ended without a plan: download only. */
  canSync: boolean;
  limitBytes: number;
  usedBytes: number;
  trialEndsAt: number;
  periodEnd: number | null;
  cancelAtPeriodEnd: boolean;
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

export type SyncState =
  /** No sync server configured in this build. */
  | "off"
  /** Needs an account: sign in by email. */
  | "signed-out"
  /** Server reachable, no vault yet: create one with a password. */
  | "setup"
  /** The vault exists but this device hasn't unlocked it. */
  | "locked"
  | "on";

export interface SyncStatus {
  state: SyncState;
  /** Last problem, cleared by the next good cycle. */
  error?: string;
  lastSyncAt?: number;
  syncApiKeys: boolean;
  /** Signed-in account and plan (absent in the dev-token setup). */
  account?: AccountInfo;
}

/** How often the outbox is checked (locally — no request unless there's something to send). */
const TICK_MS = 3000;
/** How often other devices' changes are fetched when nothing else prompts a cycle. */
const PULL_MS = import.meta.env.DEV ? 3000 : 30_000;
const MAX_BACKOFF_MS = 60_000;
const PUSH_BATCH = 200;
/** Records above this travel as blobs (the server's change-log cap is 1.5M chars, after base64). */
const MAX_INLINE = 1_000_000;
/** Larger than any real row; such a record is kept local and logged. */
const MAX_RECORD = 50_000_000;
/** Tables whose rows can point at media files (refresh views when files land). */
const MEDIA_TABLES = ["notebooks", "folders", "sources", "images", "artifacts", "messages"];
/** A file another device hasn't uploaded yet is retried this often. */
const DOWNLOAD_RETRY_MS = 30_000;
/** How often the plan and storage use are refreshed while syncing (and whenever Settings → Sync opens). */
const ACCOUNT_REFRESH_MS = import.meta.env.DEV ? 60_000 : 10 * 60_000;
export const MIN_PASSWORD = 10;

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

/** This install's own values (device id, vault key, account): never in the database or backups. */
const deviceStore = platform.kv;

/**
 * This install's device id lives outside the database, so a database that
 * arrived from elsewhere (a restored backup, a copied folder) is noticed: it
 * adopts this install's id and re-pulls from the start, and last-writer-wins
 * decides, row by row, which version is newer.
 */
async function deviceId(): Promise<string> {
  let id = await deviceStore.get<string>("deviceId");
  if (!id) {
    id = uid();
    await deviceStore.set("deviceId", id);
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
  platform.sync.log(line);
}

/* --------------------------------- server -------------------------------- */

async function api<T>(cfg: SyncConfig, path: string, body?: unknown, method?: string): Promise<T> {
  const res = await platform.fetch(`${cfg.url.replace(/\/$/, "")}/v1/vaults/${cfg.vault}/${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    connectTimeout: 15000,
  });
  if (!res.ok) throw await serverError(res);
  return (await res.json()) as T;
}

/** Errors worded for people; 402/413 also tell the loop to stop uploading. */
async function serverError(res: Response): Promise<Error> {
  let detail = "";
  try {
    detail = ((await res.json()) as { error?: string }).error ?? "";
  } catch {
    /* not JSON */
  }
  if (res.status === 402) return new Error(`sync server: HTTP 402 ${detail || "No active plan."}`);
  if (res.status === 413 && detail === "storage full")
    return new Error("sync server: HTTP 413 Your sync storage is full. Choose a bigger plan or remove large files.");
  if (res.status === 401) return new Error("sync server: HTTP 401 Signed out — sign in again in Settings → Sync.");
  return new Error(`sync server: HTTP ${res.status} ${detail}`.trim());
}

function blobUrl(cfg: SyncConfig, id: string): string {
  return `${cfg.url.replace(/\/$/, "")}/v1/vaults/${cfg.vault}/blobs/${encodeURIComponent(id)}`;
}

async function putRemoteBlob(cfg: SyncConfig, id: string, bytes: Uint8Array): Promise<void> {
  const res = await platform.fetch(blobUrl(cfg, id), {
    method: "PUT",
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/octet-stream" },
    body: bytes,
    connectTimeout: 15000,
  });
  if (!res.ok) throw await serverError(res);
}

/** The blob's bytes, or null if the server doesn't have it (yet). */
async function getRemoteBlob(cfg: SyncConfig, id: string): Promise<Uint8Array | null> {
  const res = await platform.fetch(blobUrl(cfg, id), {
    headers: { authorization: `Bearer ${cfg.token}` },
    connectTimeout: 15000,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`sync server: download: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function getEnvelope(cfg: SyncConfig): Promise<{ envelope: Envelope | null; version: number }> {
  const res = await api<{ envelope: string | null; version: number }>(cfg, "keys");
  return { envelope: res.envelope ? (JSON.parse(res.envelope) as Envelope) : null, version: res.version };
}

async function putEnvelope(cfg: SyncConfig, envelope: Envelope, expectVersion: number): Promise<void> {
  const res = await platform.fetch(`${cfg.url.replace(/\/$/, "")}/v1/vaults/${cfg.vault}/keys`, {
    method: "PUT",
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    body: JSON.stringify({ envelope: JSON.stringify(envelope), expectVersion }),
    connectTimeout: 15000,
  });
  if (res.status === 409) throw new Error("Another device changed the sync password at the same time. Try again.");
  if (!res.ok) throw new Error(`sync server: HTTP ${res.status}`);
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

/** Records that wouldn't decrypt, logged once each (wrong vault key, tampering). */
const unreadable = new Set<string>();

async function pull(cfg: SyncConfig, keys: VaultKeys, device: string, clock: Clock, out: RemoteChanges): Promise<void> {
  const syncKeys = (await getState("sync_api_keys")) !== "0";
  let cursor = Number((await getState("cursor")) || "0");
  for (;;) {
    const res = await api<{
      changes: { key: string; hlc: string; payload: string }[];
      cursor: number;
      more: boolean;
      epoch?: number;
    }>(cfg, `pull?since=${cursor}&limit=500`);
    await noteSweeps(res.epoch);
    const batch: { tbl: string; row_id: string; hlc: string; deleted: boolean; row?: Record<string, unknown> }[] = [];
    for (const c of res.changes) {
      clock.observe(c.hlc);
      let p: Payload;
      let pointer: string | null = null;
      try {
        p = JSON.parse(await decryptRecord(keys, c.key, c.payload));
        if (p.blob) {
          pointer = p.blob;
          const sealed = await getRemoteBlob(cfg, p.blob);
          if (!sealed) throw new Error(`record blob is missing`);
          p = JSON.parse(new TextDecoder().decode(await decryptBlob(keys, p.blob, sealed)));
        }
        // The record must be the one its (hidden) key names.
        if ((await hiddenId(keys, `${p.tbl}:${p.id}`)) !== c.key) throw new SyntaxError("key mismatch");
        // This is the server's current record for the row, whether or not it wins here.
        await setRecordBlob(p.tbl, p.id, pointer);
      } catch (e) {
        if (!(e instanceof Error) || e.message.startsWith("sync server")) throw e; // network: retry the page
        if (!unreadable.has(c.key)) log(`skipped a record that doesn't decrypt (${e.message})`, true);
        unreadable.add(c.key);
        continue;
      }
      if (p.v !== 1 || !(p.tbl in SYNCED_TABLES)) continue; // from a newer app version
      if (p.tbl === "settings" && !syncsSetting(p.id, syncKeys)) continue;
      batch.push({ tbl: p.tbl, row_id: p.id, hlc: c.hlc, deleted: p.deleted, row: p.row });
    }
    if (batch.length > 0) {
      const { applied } = await platform.sync.apply(device, batch);
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
async function push(cfg: SyncConfig, keys: VaultKeys, device: string, clock: Clock): Promise<number> {
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
    /** Each record's own file (rows too big for the change log), by key. */
    const pointers = new Map<string, string | null>();
    const sent: { tbl: string; row_id: string; changed_at: number; hlc: string | null }[] = [];
    const sentByKey = new Map<string, (typeof sent)[number]>();
    for (const e of entries) {
      const label = `${e.tbl}:${e.row_id}`;
      if (!SYNCED_TABLES[e.tbl] || (e.tbl === "settings" && !syncsSetting(e.row_id, syncKeys))) {
        sent.push({ ...e, hlc: null }); // never leaves this device: just clear it
        continue;
      }
      const row = rows.get(label);
      let json = JSON.stringify({ v: 1, tbl: e.tbl, id: e.row_id, deleted: !row, ...(row ? { row } : {}) });
      if (json.length > MAX_RECORD) {
        if (!oversized.has(label)) log(`${label} is too large to sync (${json.length} chars)`, true);
        oversized.add(label);
        continue;
      }
      for (const ref of blobRefsIn(json)) media.toUpload.add(ref.slice(BLOB_PREFIX.length));
      let pointer: string | null = null;
      if (json.length > MAX_INLINE) {
        const bytes = new TextEncoder().encode(json);
        pointer = await hiddenId(keys, `rec:${await sha256Hex(bytes)}`);
        await putRemoteBlob(cfg, pointer, await encryptBlob(keys, pointer, bytes));
        json = JSON.stringify({ v: 1, blob: pointer });
      }
      const key = await hiddenId(keys, label);
      const hlc = clock.next(e.changed_at);
      changes.push({ key, hlc, payload: await encryptRecord(keys, key, json) });
      const s = { ...e, hlc };
      sent.push(s);
      sentByKey.set(key, s);
      pointers.set(key, pointer);
    }

    // Files first, so a device that pulls these rows can fetch what they point at.
    await uploadMedia(cfg, keys);
    if (changes.length > 0) {
      const res = await api<{ accepted: number; stale: string[] }>(cfg, "push", { device, changes });
      accepted += res.accepted;
      // Stale = the server already holds a newer version; drop ours (it lost).
      for (const k of res.stale) {
        const s = sentByKey.get(k);
        if (s) s.hlc = null;
      }
      // Accepted records are now the server's current ones.
      for (const [k, s] of sentByKey) if (s.hlc !== null) await setRecordBlob(s.tbl, s.row_id, pointers.get(k) ?? null);
    }
    await platform.sync.markPushed(sent);
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

/** A file's server-side id: hidden, so the server can't recognise it by its hash. */
const fileId = (keys: VaultKeys, name: string) => hiddenId(keys, `file:${name}`);

async function scanMedia(): Promise<void> {
  const names = (await referencedBlobRefs()).map((r) => r.slice(BLOB_PREFIX.length));
  const absent = new Set(await platform.blobs.missing(names));
  for (const n of names) (absent.has(n) ? media.wanted : media.toUpload).add(n);
  media.scanned = true;
}

/** Upload files the server lacks. */
async function uploadMedia(cfg: SyncConfig, keys: VaultKeys): Promise<void> {
  // Each file leaves the queue only once it's settled, so an error keeps the rest.
  for (const n of media.toUpload) if (media.onServer.has(n)) media.toUpload.delete(n);
  const pending = [...media.toUpload];
  for (let i = 0; i < pending.length; i += 1000) {
    const names = pending.slice(i, i + 1000);
    const ids = await Promise.all(names.map((n) => fileId(keys, n)));
    const { missing } = await api<{ missing: string[] }>(cfg, "blobs/missing", { ids });
    const need = new Set(missing);
    for (const [j, name] of names.entries()) {
      if (!need.has(ids[j])) {
        media.onServer.add(name);
        media.toUpload.delete(name);
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = await mediaBytes(`${BLOB_PREFIX}${name}`);
      } catch {
        media.toUpload.delete(name);
        media.wanted.add(name); // not on this device either: maybe another one has it
        continue;
      }
      await putRemoteBlob(cfg, ids[j], await encryptBlob(keys, ids[j], bytes));
      media.onServer.add(name);
      media.toUpload.delete(name);
      media.uploaded += 1;
    }
  }
}

/**
 * The web app (on a phone) doesn't download every file up front: images come
 * right away (covers, pictures — small, and needed to browse), audio, video
 * and PDFs the first time they're opened (`fetchFileNow`, asked for by the
 * web build's service worker). Either way a file stays on the device after.
 */
const UP_FRONT_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif", "svg", "avif", "heic", "bmp", "tif", "tiff"]);
const downloadsUpFront = (name: string) =>
  platform.kind === "desktop" || UP_FRONT_EXT.has(name.slice(name.lastIndexOf(".") + 1));

/** Fetch, decrypt and store one file; "absent" = the server doesn't have it (yet). */
async function fetchFile(cfg: SyncConfig, keys: VaultKeys, name: string): Promise<"landed" | "absent" | "damaged"> {
  const id = await fileId(keys, name);
  const sealed = await getRemoteBlob(cfg, id);
  if (!sealed) return "absent";
  let ref = "";
  try {
    ref = await putBlob(await decryptBlob(keys, id, sealed), name.slice(name.lastIndexOf(".") + 1));
  } catch {
    /* doesn't decrypt: reported below */
  }
  if (ref !== `${BLOB_PREFIX}${name}`) {
    log(`file ${name} arrived damaged (it doesn't decrypt to what its name says) — skipped`, true);
    return "damaged";
  }
  media.onServer.add(name);
  return "landed";
}

/** Download files rows point at that this device lacks; returns how many landed. */
async function downloadMedia(cfg: SyncConfig, keys: VaultKeys): Promise<number> {
  if (media.wanted.size === 0) return 0;
  const now = Date.now();
  const due = [...media.wanted].filter((n) => downloadsUpFront(n) && (media.retryAt.get(n) ?? 0) <= now);
  if (due.length === 0) return 0;
  const absent = new Set(await platform.blobs.missing(due));
  let landed = 0;
  for (const name of due) {
    if (!absent.has(name)) {
      media.wanted.delete(name); // already here
      continue;
    }
    const result = await fetchFile(cfg, keys, name);
    if (result === "absent") {
      media.retryAt.set(name, now + DOWNLOAD_RETRY_MS);
      continue;
    }
    media.wanted.delete(name);
    media.retryAt.delete(name);
    if (result !== "landed") continue;
    markArrived(name);
    landed += 1;
  }
  return landed;
}

const fetching = new Map<string, Promise<boolean>>();

/** A file this device lacks, needed now (it's being opened); true once it's stored here. */
function fetchFileNow(name: string): Promise<boolean> {
  if (!cfg || !vault) return Promise.resolve(false);
  const c = cfg;
  const keys = vault.keys;
  let p = fetching.get(name);
  if (!p) {
    p = fetchFile(c, keys, name)
      .then(
        (r) => {
          if (r === "landed") media.wanted.delete(name);
          return r === "landed";
        },
        (e) => {
          log(`couldn't download ${name}: ${e instanceof Error ? e.message : e}`, true);
          return false;
        }
      )
      .finally(() => fetching.delete(name));
    fetching.set(name, p);
  }
  return p;
}

/* --------------------------- unused files (sweep) -------------------------- */

/**
 * The server can't read which files the library uses, so an up-to-date device
 * tells it (sync-server/src/vault.ts, `sweep`): every media file rows point at,
 * plus each big row's own record file. Files left out (deleted media, old
 * copies of edited big rows, failed uploads) are deleted from the server and
 * stop counting against the plan. Runs every few hours, and soon after the
 * storage manager deletes something (`requestStorageSweep`).
 */
const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;
let sweepWanted = false;

/** Which file a row's current server record uses (null: the record holds the row itself). */
async function setRecordBlob(tbl: string, rowId: string, blob: string | null): Promise<void> {
  const d = await getDb();
  if (blob)
    await d.execute(
      "INSERT INTO sync_record_blobs (tbl, row_id, blob) VALUES ($1, $2, $3) ON CONFLICT (tbl, row_id) DO UPDATE SET blob = $3",
      [tbl, rowId, blob]
    );
  else await d.execute("DELETE FROM sync_record_blobs WHERE tbl = $1 AND row_id = $2", [tbl, rowId]);
}

/**
 * Devices from before record files were tracked don't know them yet: pull the
 * whole vault once (nothing is re-sent, so nothing can be overwritten) and
 * note each one. Until then this device doesn't sweep.
 */
async function startRecordBlobFill(c: SyncConfig): Promise<void> {
  const state = await getState("record_blobs");
  if (state === c.vault || state === `filling:${c.vault}`) return;
  await (await getDb()).execute("DELETE FROM sync_record_blobs");
  await setState("cursor", "0");
  await setState("record_blobs", `filling:${c.vault}`);
}

async function finishRecordBlobFill(c: SyncConfig): Promise<void> {
  if ((await getState("record_blobs")) === `filling:${c.vault}`) await setState("record_blobs", c.vault);
}

/** A sweep elsewhere deleted files: check again that the server has every file this device uses. */
async function noteSweeps(epoch: number | undefined): Promise<void> {
  if (epoch === undefined || String(epoch) === (await getState("sweep_epoch"))) return;
  media.onServer.clear();
  media.scanned = false;
  await setState("sweep_epoch", String(epoch));
}

/** Free synced storage soon: the storage manager just deleted something. */
export function requestStorageSweep(): void {
  sweepWanted = true;
  wakeSoon = true;
}

async function maybeSweep(cfg: SyncConfig, keys: VaultKeys): Promise<void> {
  if (!sweepWanted && Date.now() - Number((await getState("swept_at")) || 0) < SWEEP_EVERY_MS) return;
  // Only from a complete, current view: every record read, nothing waiting to go up.
  if ((await getState("record_blobs")) !== cfg.vault || unreadable.size > 0 || media.toUpload.size > 0) return;
  const pending = await (await getDb()).select<{ k: string }[]>("SELECT tbl || ':' || row_id AS k FROM sync_outbox");
  if (pending.some((r) => !oversized.has(r.k))) return;

  const d = await getDb();
  const names = (await referencedBlobRefs()).map((r) => r.slice(BLOB_PREFIX.length));
  const recordFiles = (await d.select<{ blob: string }[]>("SELECT blob FROM sync_record_blobs")).map((r) => r.blob);
  const live = [...(await Promise.all(names.map((n) => fileId(keys, n)))), ...recordFiles];
  let res: { removed: number; freed: number };
  try {
    res = await api(cfg, "blobs/sweep", { cursor: Number((await getState("cursor")) || "0"), live });
  } catch (e) {
    // Something changed since this device last pulled (often its own push): next cycle.
    if (e instanceof Error && e.message.includes("HTTP 409")) {
      if (sweepWanted) wakeSoon = true;
      return;
    }
    throw e;
  }
  sweepWanted = false;
  await setState("swept_at", String(Date.now()));
  if (res.removed > 0) {
    const freed = res.freed >= 1e6 ? `${(res.freed / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(res.freed / 1e3))} KB`;
    log(`freed ${freed} on the server (${res.removed} unused file${res.removed === 1 ? "" : "s"})`);
    if (account) await refreshAccount().catch(() => {});
  }
}

/**
 * What the server counts for these media files and rows (storage manager):
 * file sizes by name, and each row's record (plus its own file, for big
 * rows) by `tbl:id`. Null when this device isn't syncing.
 */
export async function syncedSizes(
  names: string[],
  labels: string[]
): Promise<{ files: Map<string, number>; rows: Map<string, number> } | null> {
  if (!cfg || !vault) return null;
  const c = cfg;
  const keys = vault.keys;
  const files = new Map<string, number>();
  const rows = new Map<string, number>();
  const recordFiles = new Map(
    (await (await getDb()).select<{ k: string; blob: string }[]>("SELECT tbl || ':' || row_id AS k, blob FROM sync_record_blobs")).map(
      (r) => [r.k, r.blob]
    )
  );
  const fileIds = await Promise.all(names.map((n) => fileId(keys, n)));
  const rowKeys = await Promise.all(labels.map((l) => hiddenId(keys, l)));
  const extra = labels.map((l) => recordFiles.get(l)).filter((b): b is string => !!b);
  const blobIds = [...fileIds, ...extra];
  const blobSizes: Record<string, number> = {};
  const keySizes: Record<string, number> = {};
  for (let i = 0; i < Math.max(blobIds.length, rowKeys.length); i += 5000) {
    const res = await api<{ blobs: Record<string, number>; keys: Record<string, number> }>(c, "sizes", {
      blobs: blobIds.slice(i, i + 5000),
      keys: rowKeys.slice(i, i + 5000),
    });
    Object.assign(blobSizes, res.blobs);
    Object.assign(keySizes, res.keys);
  }
  names.forEach((n, i) => {
    if (blobSizes[fileIds[i]] !== undefined) files.set(n, blobSizes[fileIds[i]]);
  });
  labels.forEach((l, i) => {
    const own = recordFiles.get(l);
    const size = (keySizes[rowKeys[i]] ?? 0) + (own ? (blobSizes[own] ?? 0) : 0);
    if (size > 0) rows.set(l, size);
  });
  return { files, rows };
}

/* ------------------------------ status & loop ----------------------------- */

const changeListeners = new Set<(c: RemoteChanges) => void>();
const statusListeners = new Set<(s: SyncStatus) => void>();
let status: SyncStatus = { state: "off", syncApiKeys: true };

/** Subscribe to changes pulled from other devices; returns an unsubscribe. */
export function onRemoteChanges(fn: (c: RemoteChanges) => void): () => void {
  changeListeners.add(fn);
  return () => {
    changeListeners.delete(fn);
  };
}

export function getSyncStatus(): SyncStatus {
  return status;
}

/** Subscribe to sync status (Settings → Sync); returns an unsubscribe. */
export function onSyncStatus(fn: (s: SyncStatus) => void): () => void {
  statusListeners.add(fn);
  return () => {
    statusListeners.delete(fn);
  };
}

function setStatus(next: Partial<SyncStatus>): void {
  status = { ...status, ...next };
  for (const fn of statusListeners) fn(status);
}

/** The build's server settings. */
let server: ServerConfig | null = null;
/** Ready to talk to a vault: after sign-in (or with the dev token). */
let cfg: SyncConfig | null = null;
let device = "";
let clock: Clock | null = null;
/** The unlocked vault: raw key (for re-wrapping) and derived keys. */
let vault: { raw: Uint8Array; keys: VaultKeys } | null = null;
/** Each start of the loop gets a number; an older loop stops when it sees a newer one. */
let generation = 0;
let stopped = false;

// Dev: hot-swapping this module would leave views subscribed to the old copy
// while a new loop starts, so stop the old loop and reload the whole page.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stopped = true;
  });
  import.meta.hot.accept(() => window.location.reload());
}

/** Set when the window regains focus: fetch other devices' changes on the next tick. */
let wakeSoon = false;
if (typeof window !== "undefined") window.addEventListener("focus", () => (wakeSoon = true));

/** Is there anything this device should send now? (local checks only) */
async function somethingToSend(): Promise<boolean> {
  if (status.account?.canSync === false) return false;
  if (media.toUpload.size > 0) return true;
  const rows = await (await getDb()).select<{ k: string }[]>(
    "SELECT tbl || ':' || row_id AS k FROM sync_outbox LIMIT 100"
  );
  return rows.some((r) => !oversized.has(r.k));
}

function loop(): void {
  if (!cfg || !vault || !clock) return;
  const gen = ++generation;
  const c = cfg;
  const keys = vault.keys;
  const clk = clock;
  let delay = TICK_MS;
  let accountCheckedAt = 0;
  let pulledAt = 0;
  const cycle = async () => {
    if (stopped || gen !== generation) return; // signed out, or restarted with another vault
    const due = wakeSoon || Date.now() - pulledAt >= PULL_MS || (await somethingToSend().catch(() => false));
    if (!due) {
      setTimeout(cycle, TICK_MS);
      return;
    }
    wakeSoon = false;
    pulledAt = Date.now();
    const changed: RemoteChanges = { tables: new Set(), notebookIds: new Set(), chatIds: new Set() };
    try {
      if (account && Date.now() - accountCheckedAt > ACCOUNT_REFRESH_MS) {
        accountCheckedAt = Date.now();
        await refreshAccount();
      }
      await startRecordBlobFill(c);
      await pull(c, keys, device, clk, changed);
      await finishRecordBlobFill(c);
      if (!media.scanned) await scanMedia();
      const landed = await downloadMedia(c, keys);
      if (landed > 0) for (const t of MEDIA_TABLES) changed.tables.add(t);
      const before = media.uploaded;
      // Without a plan the account is read-only: keep pulling, hold uploads.
      const canUpload = status.account?.canSync !== false;
      const sent = canUpload ? await push(c, keys, device, clk) : 0;
      if (canUpload) await uploadMedia(c, keys); // files from the first scan, or left over from a failed cycle
      await maybeSweep(c, keys); // works without a plan too: it only frees space
      const uploaded = media.uploaded - before;
      if (changed.tables.size > 0 || sent > 0 || uploaded > 0)
        log(
          `pulled changes to ${[...changed.tables].join(", ") || "nothing"}; pushed ${sent}` +
            (landed || uploaded ? `; files: ${landed} down, ${uploaded} up` : "")
        );
      delay = TICK_MS;
      setStatus({ error: undefined, lastSyncAt: Date.now() });
    } catch (e) {
      delay = Math.min(Math.max(delay, PULL_MS) * 2, MAX_BACKOFF_MS);
      const msg = e instanceof Error ? e.message : String(e);
      log(`${msg} — retrying in ${delay / 1000}s`, true);
      setStatus({ error: msg.replace(/^sync server: HTTP \d+ /, "") });
      if (account && /HTTP (402|413)/.test(msg)) accountCheckedAt = 0; // plan or storage changed: re-check
      if (account && msg.includes("HTTP 401")) await forgetAccount("signed-out");
    }
    if (changed.tables.size > 0) for (const fn of changeListeners) fn(changed);
    setTimeout(cycle, delay);
  };
  void cycle();
}

/** Keep the unlocked vault key on this install and start syncing. */
async function useVault(raw: Uint8Array, fresh: boolean): Promise<void> {
  await deviceStore.set("vault", { name: requireCfg().vault, key: toBase64(raw) });
  if (fresh) await resendEverything();
  vault = { raw, keys: await deriveKeys(raw) };
  setStatus({ state: "on", error: undefined });
  loop();
}

/**
 * Joining (or creating) a vault: pull its whole history and offer every local
 * row again. Last-writer-wins keeps whichever version of each row is newer, so
 * nothing newer on either side is lost. Rows recorded before tracking began
 * have time 0, so on a device joining an existing vault the vault's copy wins.
 */
async function resendEverything(): Promise<void> {
  const d = await getDb();
  await setState("cursor", "0");
  await d.execute("UPDATE sync_meta SET hlc = ''");
  await d.execute(
    "INSERT OR IGNORE INTO sync_outbox (tbl, row_id, changed_at) SELECT tbl, row_id, changed_at FROM sync_meta WHERE deleted = 0"
  );
  media.scanned = false;
  media.onServer.clear();
  oversized.clear();
  unreadable.clear();
}

function requireCfg(): SyncConfig {
  if (!cfg) throw new Error(server ? "Sign in first." : "Sync isn't available in this build.");
  return cfg;
}

/* -------------------------------- accounts -------------------------------- */

let account: Account | null = null;
/** Bumped to abandon a sign-in that's waiting for its email link. */
let signInGeneration = 0;

async function accountApi<T>(path: string, method: string, body?: unknown, session?: string): Promise<T> {
  if (!server) throw new Error("Sync isn't available in this build.");
  const res = await platform.fetch(`${server.url.replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(session ? { authorization: `Bearer ${session}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    connectTimeout: 15000,
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      /* not JSON */
    }
    throw new Error(detail || `The sync server said HTTP ${res.status}.`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/**
 * Web app: fetch a page on the open web through the sync server, which reads
 * it on the phone's behalf (browsers can't read most sites from another
 * site's page). Needs a signed-in account (or the dev token); see webFetch.ts.
 */
export async function fetchThroughServer(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<Response> {
  const s = server ?? (await platform.sync.config());
  if (!s || !cfg?.token)
    throw new Error("Adding web pages and videos on this device needs BrewLM Sync: sign in under Settings → Sync.");
  const res = await platform.fetch(`${s.url.replace(/\/$/, "")}/v1/fetch`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    body: JSON.stringify({ url, method: init.method ?? "GET", headers: init.headers, body: init.body }),
  });
  if (res.headers.get("x-brewlm-fetch") === "error") {
    const detail = await res.json().then((j: { error?: string }) => j.error, () => undefined);
    throw new Error(detail || `The sync server couldn't fetch that page (HTTP ${res.status}).`);
  }
  return res;
}

/** Plan, trial and storage use for Settings; also decides whether this device uploads. */
export async function refreshAccount(): Promise<void> {
  if (!account) return;
  const me = await accountApi<AccountInfo>("/v1/me", "GET", undefined, account.session);
  setStatus({ account: me });
}

export interface SignIn {
  pendingId: string;
  /** Shown in the app; the confirm page shows the same code. */
  code: string;
  expiresAt: number;
}

/** Email a sign-in link. Then call `waitForSignIn`. */
export async function startSignIn(email: string): Promise<SignIn> {
  signInGeneration += 1;
  return accountApi<SignIn>("/v1/auth/start", "POST", { email });
}

/** Wait until the emailed link was confirmed (true) or the attempt expired / was abandoned (false). */
export async function waitForSignIn(attempt: SignIn): Promise<boolean> {
  const mine = signInGeneration;
  while (mine === signInGeneration && Date.now() < attempt.expiresAt) {
    type Poll = { status: string; session?: string; email?: string; vault?: string };
    const res = await accountApi<Poll>("/v1/auth/poll", "POST", { pendingId: attempt.pendingId }).catch(
      (): Poll => ({ status: "pending" }) // a network blip: keep waiting
    );
    if (res.status === "ok" && res.session && res.email && res.vault) {
      await useAccount({ session: res.session, email: res.email, vault: res.vault });
      log(`signed in as ${res.email}`);
      return true;
    }
    if (res.status === "expired") return false;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

export function cancelSignIn(): void {
  signInGeneration += 1;
}

async function useAccount(a: Account): Promise<void> {
  await deviceStore.set("account", a);
  account = a;
  cfg = { url: server!.url, token: a.session, vault: a.vault };
  await refreshAccount().catch(() => {});
  await resumeVault(cfg);
}

/** Back to signed out: forget the session (and, with it, this device's vault key). */
async function forgetAccount(state: SyncState): Promise<void> {
  generation += 1;
  vault = null;
  account = null;
  cfg = null;
  await deviceStore.delete("account");
  await deviceStore.delete("vault");
  setStatus({ state, account: undefined, error: undefined });
}

/** Choose a plan: opens Polar's checkout in the browser. */
export async function openCheckout(plan: "sync" | "plus", interval: "month" | "year"): Promise<void> {
  if (!account) throw new Error("Sign in first.");
  const { url } = await accountApi<{ url: string }>("/v1/billing/checkout", "POST", { plan, interval }, account.session);
  await platform.openUrl(url);
}

/** Change plan, card or cancel: opens Polar's billing page in the browser. */
export async function openBillingPortal(): Promise<void> {
  if (!account) throw new Error("Sign in first.");
  const { url } = await accountApi<{ url: string }>("/v1/billing/portal", "POST", undefined, account.session);
  await platform.openUrl(url);
}

/** First device: create the vault. Returns the recovery key to show (once). */
export async function setUpSync(password: string): Promise<string> {
  const c = requireCfg();
  if (password.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters.`);
  const { envelope, version } = await getEnvelope(c);
  if (envelope || version > 0) throw new Error("This sync account already has a password — unlock it instead.");
  const raw = newVaultKey();
  const recovery = newRecoveryKey();
  await putEnvelope(c, await createEnvelope(raw, password, recovery), 0);
  await useVault(raw, true);
  log("vault created");
  return formatRecoveryKey(recovery);
}

/** Another device: unlock the existing vault with the sync password. */
export async function unlockSync(password: string): Promise<void> {
  const { envelope } = await getEnvelope(requireCfg());
  if (!envelope) throw new Error("Sync hasn't been set up yet.");
  await useVault(await unlockWithPassword(envelope, password), true);
  log("vault unlocked");
}

/** Forgot the password: unlock with the recovery key and choose a new password. */
export async function recoverSync(recoveryKey: string, newPassword: string): Promise<void> {
  const c = requireCfg();
  if (newPassword.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters.`);
  const { envelope, version } = await getEnvelope(c);
  if (!envelope) throw new Error("Sync hasn't been set up yet.");
  const raw = await unlockWithRecovery(envelope, recoveryKey);
  await putEnvelope(c, await rewrapPassword(envelope, raw, newPassword), version);
  await useVault(raw, true);
  log("vault recovered with the recovery key; password changed");
}

export async function changeSyncPassword(newPassword: string): Promise<void> {
  const c = requireCfg();
  if (!vault) throw new Error("Unlock sync first.");
  if (newPassword.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters.`);
  const { envelope, version } = await getEnvelope(c);
  if (!envelope) throw new Error("Sync hasn't been set up yet.");
  await putEnvelope(c, await rewrapPassword(envelope, vault.raw, newPassword), version);
}

/** Replace the recovery key (the old one stops working). Returns the new one to show. */
export async function newSyncRecoveryKey(): Promise<string> {
  const c = requireCfg();
  if (!vault) throw new Error("Unlock sync first.");
  const { envelope, version } = await getEnvelope(c);
  if (!envelope) throw new Error("Sync hasn't been set up yet.");
  const recovery = newRecoveryKey();
  await putEnvelope(c, await rewrapRecovery(envelope, vault.raw, recovery), version);
  return formatRecoveryKey(recovery);
}

export interface DeviceLink {
  /** What the QR code holds. */
  uri: string;
  /** The same secret, to type. */
  code: string;
  expiresAt: number;
  id: string;
}

/** Signed-in device: make a one-time link a new device can use instead of the password. */
export async function startDeviceLink(): Promise<DeviceLink> {
  const c = requireCfg();
  if (!vault) throw new Error("Unlock sync first.");
  const secret = newLinkSecret();
  const id = await linkId(secret);
  const { expires } = await api<{ expires: number }>(c, `links/${id}`, { sealed: await sealForLink(secret, vault.raw) }, "PUT");
  return { uri: linkUri(c.vault, secret), code: formatLinkCode(secret), expiresAt: expires, id };
}

/** Is the link still waiting for its device? (false once used, cancelled or expired) */
export async function deviceLinkPending(id: string): Promise<boolean> {
  return (await api<{ pending: boolean }>(requireCfg(), `links/${id}/status`)).pending;
}

export async function cancelDeviceLink(id: string): Promise<void> {
  const c = requireCfg();
  await platform.fetch(`${c.url.replace(/\/$/, "")}/v1/vaults/${c.vault}/links/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${c.token}` },
    connectTimeout: 15000,
  }).catch(() => {});
}

/** New device: join the vault with a link scanned or typed from a signed-in device. */
export async function linkThisDevice(text: string): Promise<void> {
  const c = requireCfg();
  const parsed = parseLink(text);
  if (!parsed) throw new Error("That isn't a link code — it's 52 letters and numbers.");
  if (parsed.vault && parsed.vault !== c.vault) throw new Error("That code is for a different sync account.");
  let sealed: string;
  try {
    ({ sealed } = await api<{ sealed: string }>(c, `links/${await linkId(parsed.secret)}`));
  } catch (e) {
    if (e instanceof Error && e.message.includes("HTTP 404"))
      throw new Error("That code has expired or was already used. Make a new one on your other device.");
    throw e;
  }
  await useVault(await openLink(parsed.secret, sealed), true);
  log("device linked");
}

/**
 * Stop syncing on this device and forget its copy of the vault key (and, with
 * an account, sign out of it). Local data stays.
 */
export async function signOutOfSync(): Promise<void> {
  if (account) {
    const session = account.session;
    await forgetAccount("signed-out");
    await accountApi("/v1/auth/session", "DELETE", undefined, session).catch(() => {});
    return;
  }
  generation += 1;
  vault = null;
  await deviceStore.delete("vault");
  setStatus({ state: "locked", error: undefined });
}

export async function setSyncApiKeys(on: boolean): Promise<void> {
  await setState("sync_api_keys", on ? "1" : "0");
  // Turned back on: offer the keys again (they were cleared from the outbox).
  if (on)
    await (await getDb()).execute(
      `INSERT OR IGNORE INTO sync_outbox (tbl, row_id, changed_at)
       SELECT 'settings', key, 0 FROM settings WHERE key IN (${[...API_KEY_SETTINGS].map((k) => `'${k}'`).join(", ")})`
    );
  setStatus({ syncApiKeys: on });
}

/** Start syncing if this build has a sync server configured (dev builds, for now). */
export async function startSync(): Promise<void> {
  if (server) return;
  const s = await platform.sync.config();
  if (!s) return;
  server = s;
  platform.blobs.onMissing?.(fetchFileNow);
  device = await deviceId();
  clock = Clock.parse(device, await getState("hlc_last"));
  setStatus({ syncApiKeys: (await getState("sync_api_keys")) !== "0" });

  if (s.token) {
    // Dev: shared token, fixed vault, no account.
    cfg = { url: s.url, token: s.token, vault: s.vault ?? "dev", password: s.password };
    log(`server ${s.url}, vault "${cfg.vault}" (dev token), device ${device.slice(0, 8)}`);
    await resumeVault(cfg);
    return;
  }
  log(`server ${s.url}, device ${device.slice(0, 8)}`);
  const saved = await deviceStore.get<Account>("account");
  if (!saved) return setStatus({ state: "signed-out" });
  account = saved;
  cfg = { url: s.url, token: saved.session, vault: saved.vault };
  await refreshAccount().catch((e) => {
    if (e instanceof Error && /HTTP 401|unauthorized/i.test(e.message)) void forgetAccount("signed-out");
  });
  if (cfg) await resumeVault(cfg);
}

/** Use this device's saved vault key, or find out whether the vault needs setting up or unlocking. */
async function resumeVault(c: SyncConfig): Promise<void> {
  const saved = await deviceStore.get<{ name: string; key: string }>("vault");
  if (saved?.name === c.vault) {
    vault = { raw: fromBase64(saved.key), keys: await deriveKeys(fromBase64(saved.key)) };
    setStatus({ state: "on" });
    loop();
    return;
  }
  await checkVault(c, TICK_MS);
}

/** Does the vault exist yet? Retried with backoff while the server is unreachable (offline at launch). */
async function checkVault(c: SyncConfig, delay: number): Promise<void> {
  let envelope: Envelope | null;
  try {
    ({ envelope } = await getEnvelope(c));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus({ state: status.state === "off" ? "locked" : status.state, error: `Can't reach the sync server (${msg})` });
    log(`can't reach the sync server — retrying in ${delay / 1000}s`, true);
    setTimeout(() => {
      if (cfg === c) void checkVault(c, Math.min(delay * 2, MAX_BACKOFF_MS));
    }, delay);
    return;
  }
  if (vault || cfg !== c) return; // unlocked from Settings meanwhile, or signed out
  setStatus({ state: envelope ? "locked" : "setup", error: undefined });
  if (!c.password) return;
  try {
    if (envelope) await unlockSync(c.password);
    else log(`dev: vault created; recovery key ${await setUpSync(c.password)}`);
  } catch (e) {
    setStatus({ error: e instanceof Error ? e.message : String(e) });
    log(`dev password didn't work: ${e instanceof Error ? e.message : e}`, true);
  }
}
