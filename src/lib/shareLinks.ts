/**
 * Shared links: publish a notebook as a read-only snapshot anyone with the
 * link can open (sync-server/src/shares.ts stores it).
 *
 * A link is `https://app.brewlm.com/s/<id>#<key>`. The key is 32 random
 * bytes; everything the server gets is encrypted with keys derived from it
 * (the vault's own scheme, vaultCrypto.ts), and browsers never send the part
 * after `#`, so the server can't read a shared notebook either.
 *
 * What's uploaded:
 * - each media file the snapshot uses (unless media is left out), encrypted,
 *   under a hidden id of its `brewblob:` name;
 * - the manifest: `{ v, sharedBy, files, snapshot }`, gzipped and encrypted.
 *   `files` lists the media that were included, so a viewer knows which are
 *   missing on purpose.
 * Updating a link uploads only files the server doesn't have yet, replaces
 * the manifest (versioned, so readers never see half of it) and then removes
 * files the new version no longer uses.
 *
 * Each link's key lives in the synced `shares` table, so any of the owner's
 * devices can update or stop it.
 */
import { mediaBytes } from "./blobs";
import { getDb } from "./db";
import { readSnapshot, snapshotBlobRefs, type NotebookSnapshot } from "./share";
import { shareServer } from "./sync";
import { deriveKeys, encryptBlob, hiddenId, randomBytes, type VaultKeys } from "./vaultCrypto";
import { platform } from "../platform";

/** Where links open: the web app. */
export const SHARE_APP_URL = import.meta.env.DEV ? "http://localhost:1430" : "https://app.brewlm.com";
export const MANIFEST_ID = "manifest";
const MAX_MISSING = 1000;

export interface ShareRow {
  id: string;
  notebook_id: string;
  /** base64url, 32 bytes. */
  share_key: string;
  version: number;
  include_chats: number;
  include_media: number;
  shared_by: string;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

/** What a link holds once decrypted. */
export interface ShareManifest {
  v: 1;
  /** Optional name the owner chose ("" = none). */
  sharedBy: string;
  /** `brewblob:` references whose files were uploaded. */
  files: string[];
  snapshot: NotebookSnapshot;
}

export interface ShareOptions {
  includeChats: boolean;
  includeMedia: boolean;
  sharedBy: string;
  /** null = never. */
  expiresAt: number | null;
}

/* -------------------------------- bytes ---------------------------------- */

export function toBase64Url(b: Uint8Array): string {
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/** The keys a link's secret opens: the same derivation as a vault's. */
export function shareKeys(secret: Uint8Array): Promise<VaultKeys> {
  return deriveKeys(secret);
}

/** Server-side name of a shared media file. */
export const shareFileId = (keys: VaultKeys, ref: string) => hiddenId(keys, `file:${ref}`);

/* --------------------------------- links --------------------------------- */

export const shareUrl = (s: Pick<ShareRow, "id" | "share_key">) => `${SHARE_APP_URL}/s/${s.id}#${s.share_key}`;

/** `{ id, secret }` from a pasted link (or null if it isn't one). */
export function parseShareUrl(text: string): { id: string; secret: Uint8Array } | null {
  const m = /\/s\/([0-9a-f]{32})\/?#([A-Za-z0-9_-]{43})\s*$/.exec(text.trim());
  if (!m) return null;
  const secret = fromBase64Url(m[2]);
  return secret?.length === 32 ? { id: m[1], secret } : null;
}

/* --------------------------------- server -------------------------------- */

function signedIn(): { url: string; session: string } {
  const s = shareServer();
  if (!s) throw new Error("Sharing links needs BrewLM Sync: sign in under Settings → Sync.");
  return s;
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const s = signedIn();
  const res = await platform.fetch(`${s.url}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${s.session}`,
      ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}),
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
  if (!res.ok && res.status !== 409) {
    const detail = await res.json().then((j: { error?: string }) => j.error, () => undefined);
    if (res.status === 413 && detail === "storage full")
      throw new Error("Your BrewLM storage is full. Leave media out, or choose a bigger plan.");
    throw new Error(detail || `The sync server said HTTP ${res.status}.`);
  }
  return res;
}

/* ------------------------------ local rows ------------------------------- */

export async function listShares(notebookId?: string): Promise<ShareRow[]> {
  const d = await getDb();
  return notebookId
    ? d.select<ShareRow[]>("SELECT * FROM shares WHERE notebook_id = $1 ORDER BY created_at DESC", [notebookId])
    : d.select<ShareRow[]>("SELECT * FROM shares ORDER BY created_at DESC");
}

async function saveRow(r: ShareRow): Promise<void> {
  const d = await getDb();
  await d.execute(
    `INSERT INTO shares (id, notebook_id, share_key, version, include_chats, include_media, shared_by, expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO UPDATE SET version = $4, include_chats = $5, include_media = $6, shared_by = $7, expires_at = $8, updated_at = $10`,
    [r.id, r.notebook_id, r.share_key, r.version, r.include_chats, r.include_media, r.shared_by, r.expires_at, r.created_at, r.updated_at]
  );
}

async function dropRow(id: string): Promise<void> {
  const d = await getDb();
  await d.execute("DELETE FROM shares WHERE id = $1", [id]);
}

/* -------------------------------- publish -------------------------------- */

export interface Progress {
  done: number;
  total: number;
}

/**
 * Upload a notebook's current state to its link: a new link when `existing`
 * is absent, otherwise an update of that one (same address). Returns the row.
 */
export async function publishShare(
  notebookId: string,
  opts: ShareOptions,
  existing?: ShareRow,
  onProgress?: (p: Progress) => void
): Promise<ShareRow> {
  signedIn();
  const snapshot = await readSnapshot(notebookId, { includeChats: opts.includeChats });
  const row: ShareRow = existing
    ? { ...existing }
    : {
        id: ((await (await call("/v1/shares", { method: "POST" })).json()) as { id: string }).id,
        notebook_id: notebookId,
        share_key: toBase64Url(randomBytes(32)),
        version: 0,
        include_chats: 0,
        include_media: 1,
        shared_by: "",
        expires_at: null,
        created_at: Date.now(),
        updated_at: 0,
      };
  // Remember a new link at once: if anything below fails, it can still be retried or stopped.
  if (!existing) await saveRow(row);
  const secret = fromBase64Url(row.share_key);
  if (!secret || secret.length !== 32) throw new Error("This link's key is damaged. Stop sharing it and make a new one.");
  const keys = await shareKeys(secret);
  const base = `/v1/shares/${row.id}`;

  // Media: the cover always (it's small and shows on the link's card), the rest if wanted.
  const cover = new Set([snapshot.notebook.cover, snapshot.notebook.chat_bg].filter(Boolean));
  const refs = snapshotBlobRefs(snapshot).filter((r) => opts.includeMedia || cover.has(r));
  const ids = new Map<string, string>();
  for (const r of refs) ids.set(r, await shareFileId(keys, r));
  const missing = new Set<string>();
  const all = [...ids.values()];
  for (let i = 0; i < all.length; i += MAX_MISSING) {
    const res = await call(`${base}/blobs/missing`, { method: "POST", body: JSON.stringify({ ids: all.slice(i, i + MAX_MISSING) }) });
    for (const id of ((await res.json()) as { missing: string[] }).missing) missing.add(id);
  }
  const files: string[] = [];
  const total = missing.size + 1;
  let done = 0;
  onProgress?.({ done, total });
  for (const [ref, id] of ids) {
    if (missing.has(id)) {
      let bytes: Uint8Array;
      try {
        bytes = await mediaBytes(ref);
      } catch {
        continue; // not on this device (yet): the link goes out without it
      }
      const sealed = await encryptBlob(keys, id, bytes);
      await call(`${base}/blobs/${id}`, { method: "PUT", body: sealed as BodyInit, headers: { "content-type": "application/octet-stream" } });
      onProgress?.({ done: ++done, total });
    }
    files.push(ref);
  }

  const manifest: ShareManifest = { v: 1, sharedBy: opts.sharedBy.trim(), files, snapshot };
  const sealed = await encryptBlob(keys, MANIFEST_ID, await gzip(JSON.stringify(manifest)));
  let version = row.version;
  for (let attempt = 0; ; attempt++) {
    const res = await call(`${base}/manifest?expect=${version}`, {
      method: "PUT",
      body: sealed as BodyInit,
      headers: { "content-type": "application/octet-stream" },
    });
    const body = (await res.json()) as { version: number };
    if (res.ok) {
      version = body.version;
      break;
    }
    // Another of this account's devices updated it meanwhile: this copy is newer.
    if (attempt > 0) throw new Error("This link is being updated from another device. Try again in a moment.");
    version = body.version;
  }
  onProgress?.({ done: total, total });

  // Tidy up files the new version doesn't use (best effort: a failure costs space, not correctness).
  await call(`${base}/sweep`, { method: "POST", body: JSON.stringify({ live: files.map((r) => ids.get(r)!) }) }).catch(
    (e) => console.warn("share: sweep failed", e)
  );
  if (opts.expiresAt !== (existing?.expires_at ?? null)) await setShareExpiry(row, opts.expiresAt, false);

  const out: ShareRow = {
    ...row,
    version,
    include_chats: opts.includeChats ? 1 : 0,
    include_media: opts.includeMedia ? 1 : 0,
    shared_by: manifest.sharedBy,
    expires_at: opts.expiresAt,
    updated_at: Date.now(),
  };
  await saveRow(out);
  return out;
}

export async function setShareExpiry(row: ShareRow, expiresAt: number | null, save = true): Promise<void> {
  await call(`/v1/shares/${row.id}`, { method: "PATCH", body: JSON.stringify({ expiresAt }) });
  if (save) await saveRow({ ...row, expires_at: expiresAt, updated_at: Date.now() });
}

/** The link stops working for everyone, at once. */
export async function stopSharing(row: Pick<ShareRow, "id">): Promise<void> {
  await call(`/v1/shares/${row.id}`, { method: "DELETE" }).catch((e: Error) => {
    if (!/no such share/i.test(e.message)) throw e; // already gone is fine
  });
  await dropRow(row.id);
}

/** A new address for the same notebook; the old link stops working. */
export async function resetShare(row: ShareRow, onProgress?: (p: Progress) => void): Promise<ShareRow> {
  const opts: ShareOptions = {
    includeChats: !!row.include_chats,
    includeMedia: !!row.include_media,
    sharedBy: row.shared_by,
    expiresAt: row.expires_at,
  };
  await stopSharing(row);
  return publishShare(row.notebook_id, opts, undefined, onProgress);
}

/** From the server: views, size and whether a link was taken down. */
export interface ShareInfo {
  id: string;
  version: number;
  bytes: number;
  views: number;
  expiresAt: number | null;
  disabled: boolean;
}

export async function fetchShareInfo(): Promise<Map<string, ShareInfo>> {
  const res = await call("/v1/shares");
  const { shares } = (await res.json()) as { shares: ShareInfo[] };
  return new Map(shares.map((s) => [s.id, s]));
}

/**
 * Stop links whose notebook was deleted for good (after Trash is emptied, or
 * on another device), and forget links the server no longer has (expired, or
 * stopped elsewhere).
 */
export async function cleanUpShares(): Promise<void> {
  if (!shareServer()) return;
  const d = await getDb();
  const orphans = await d.select<ShareRow[]>("SELECT * FROM shares WHERE notebook_id NOT IN (SELECT id FROM notebooks)");
  for (const r of orphans) await stopSharing(r).catch((e) => console.warn("share: couldn't stop", r.id, e));
  const onServer = await fetchShareInfo().catch(() => null);
  if (!onServer) return;
  // A link only just created may not be listed yet; give it an hour.
  for (const r of await listShares())
    if (!onServer.has(r.id) && r.created_at < Date.now() - 3_600_000) await dropRow(r.id);
}
