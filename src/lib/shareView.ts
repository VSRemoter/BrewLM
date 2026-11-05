/**
 * Opening someone's shared link (see shareLinks.ts for the owner's side).
 *
 * The link names the share and carries its key after `#`. This fetches the
 * encrypted snapshot from the sync server (no account needed), decrypts it,
 * downloads the media files it includes, and writes it as a read-only
 * notebook (share.ts `writeSharedSnapshot`). Opening the same link again, or
 * `checkSharedUpdate` finding a newer version, brings that notebook up to date
 * in place. Shared notebooks stay on this device: Sync skips them.
 */
import { BLOB_PREFIX, mediaExt, putBlob } from "./blobs";
import { getDb } from "./db";
import { omitMedia, writeSharedSnapshot } from "./share";
import { fromBase64Url, gunzip, MANIFEST_ID, shareFileId, shareKeys, toBase64Url, type Progress, type ShareManifest } from "./shareLinks";
import { syncServerUrl } from "./sync";
import { decryptBlob } from "./vaultCrypto";
import { platform } from "../platform";
import type { Notebook } from "./types";

const GONE = "This shared notebook is no longer available. The owner stopped sharing it, or the link expired.";

async function server(): Promise<string> {
  const url = await syncServerUrl();
  if (!url) throw new Error("Shared links can't be opened in this build.");
  return url;
}

async function get(path: string): Promise<Response> {
  const res = await platform.fetch(`${await server()}${path}`, { method: "GET", connectTimeout: 15000 });
  if (res.status === 410) throw new Error(GONE);
  if (res.status === 404) throw new Error("This link doesn't lead to a shared notebook. Check that it was copied in full.");
  if (!res.ok) throw new Error(`The sync server said HTTP ${res.status}.`);
  return res;
}

/** The link's current version, or an error worded for people. */
export async function sharedVersion(id: string): Promise<number> {
  return ((await (await get(`/v1/shares/${id}`)).json()) as { version: number }).version;
}

/**
 * Open a link: download it into a read-only notebook (or update the one
 * already here) and return the notebook's id.
 */
export async function openSharedLink(id: string, secret: Uint8Array, onProgress?: (p: Progress) => void): Promise<string> {
  const keys = await shareKeys(secret);
  const res = await get(`/v1/shares/${id}/manifest`);
  const version = Number(res.headers.get("x-share-version") ?? "0");
  let manifest: ShareManifest;
  try {
    const bytes = await decryptBlob(keys, MANIFEST_ID, new Uint8Array(await res.arrayBuffer()));
    manifest = JSON.parse(await gunzip(bytes)) as ShareManifest;
  } catch {
    throw new Error("This link's key doesn't open it. Check that the whole link was copied, including the part after #.");
  }
  if (manifest.v !== 1) throw new Error("This notebook needs a newer version of BrewLM.");

  // Media: fetch what this device doesn't have. Files are named by their
  // content's hash, so a file that doesn't match its name is dropped.
  const names = manifest.files.map((r) => r.slice(BLOB_PREFIX.length));
  const missing = await platform.blobs.missing(names);
  let done = 0;
  onProgress?.({ done, total: missing.length + 1 });
  for (const name of missing) {
    const ref = BLOB_PREFIX + name;
    try {
      const fileId = await shareFileId(keys, ref);
      const r = await get(`/v1/shares/${id}/blobs/${fileId}`);
      const bytes = await decryptBlob(keys, fileId, new Uint8Array(await r.arrayBuffer()));
      const stored = await putBlob(bytes, mediaExt(ref));
      if (stored !== ref) console.warn("share: a file didn't match its name", name);
    } catch (e) {
      if (e instanceof Error && e.message === GONE) throw e;
      console.warn("share: couldn't fetch a file", name, e);
    }
    onProgress?.({ done: ++done, total: missing.length + 1 });
  }

  const notebookId = await writeSharedSnapshot(omitMedia(manifest.snapshot, new Set(manifest.files)), {
    id,
    key: toBase64Url(secret),
    version,
    sharedBy: manifest.sharedBy ?? "",
  });
  onProgress?.({ done: missing.length + 1, total: missing.length + 1 });
  return notebookId;
}

/** A newer version of a shared notebook's link, if there is one (null when up to date or unreachable). */
export async function checkSharedUpdate(nb: Notebook): Promise<{ version: number } | { gone: true } | null> {
  if (!nb.share_id) return null;
  try {
    const v = await sharedVersion(nb.share_id);
    return v > (nb.share_version ?? 0) ? { version: v } : null;
  } catch (e) {
    return e instanceof Error && e.message === GONE ? { gone: true } : null;
  }
}

/** Bring a shared notebook up to its link's latest version. */
export async function updateSharedNotebook(nb: Notebook, onProgress?: (p: Progress) => void): Promise<void> {
  const secret = fromBase64Url(nb.share_key ?? "");
  if (!nb.share_id || !secret) throw new Error("This notebook didn't come from a link.");
  await openSharedLink(nb.share_id, secret, onProgress);
}

/** A notebook already opened from this link, if any. */
export async function notebookForShare(id: string): Promise<string | null> {
  const d = await getDb();
  const rows = await d.select<{ id: string }[]>("SELECT id FROM notebooks WHERE share_id = $1", [id]);
  return rows[0]?.id ?? null;
}

/** Tell BrewLM a shared notebook breaks the rules (spam, abuse…); the server can't read it, so the reason matters. */
export async function reportShare(id: string, reason: string): Promise<void> {
  const res = await platform.fetch(`${await server()}/v1/shares/${id}/report`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason }),
    connectTimeout: 15000,
  });
  if (!res.ok) {
    const detail = await res.json().then((j: { error?: string }) => j.error, () => undefined);
    throw new Error(detail || `The sync server said HTTP ${res.status}.`);
  }
}
