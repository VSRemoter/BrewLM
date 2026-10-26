/**
 * Storage manager (Settings → Data & Storage): the library's biggest items,
 * each deletable in one step, for when someone runs into their Sync storage
 * limit or just wants space back.
 *
 * Sizes are what Sync counts on the server when this device syncs (files plus
 * each row's encrypted record), otherwise what the items take on this device.
 * Deleting goes through the usual db.ts calls, so it syncs like any delete;
 * then the server is asked to sweep files nothing uses any more (sync.ts), so
 * the space is freed within a sync cycle or two.
 */
import { platform } from "../platform";
import { BLOB_PREFIX, blobRefsIn, mediaSrc } from "./blobs";
import {
  deleteArtifact,
  deleteImage,
  deleteSource,
  getDb,
  pruneOrphanBlobs,
  setFolderCover,
  setNotebookChatBg,
  setNotebookCover,
} from "./db";
import { requestStorageSweep, syncedSizes } from "./sync";

export type StorageKind = "source" | "artifact" | "image" | "cover" | "chat-bg" | "folder-cover";

export interface StorageItem {
  /** Stable id for the list: "<kind>:<row id>". */
  id: string;
  kind: StorageKind;
  title: string;
  /** What it is, for people: "Audio overview", "PDF", "Notebook cover"… */
  label: string;
  /** Notebook (or folder) it belongs to; "" when none. */
  where: string;
  inTrash: boolean;
  bytes: number;
  /** Some of its files are also used by another item: deleting frees less. */
  shared: boolean;
}

interface Candidate {
  id: string;
  kind: StorageKind;
  rowId: string;
  /** "tbl:id" of the row whose record counts, or "" (covers live in their notebook's record). */
  label: string;
  title: string;
  kindLabel: string;
  where: string;
  inTrash: boolean;
  files: string[];
  /** Rough size of the row's own text on this device (when not syncing). */
  textBytes: number;
}

const ARTIFACT_LABELS: Record<string, string> = {
  audio: "Audio overview",
  drawing: "Drawing",
  report: "Report",
  research: "Deep research",
  mindmap: "Mind map",
  flashcards: "Flashcards",
  quiz: "Quiz",
  notes: "Notes",
};

function sourceLabel(type: string, mime: string | null, content: string): string {
  const m = (mime ?? "").toLowerCase();
  if (m.includes("pdf") || content.includes(".pdf")) return "PDF";
  if (type === "audio" || m.startsWith("audio/")) return m.startsWith("video/") ? "Video" : "Audio";
  if (m.startsWith("video/")) return "Video";
  if (type === "image" || m.startsWith("image/")) return "Image";
  if (type === "link") return "Web page";
  return "Source";
}

const names = (text: string) => blobRefsIn(text).map((r) => r.slice(BLOB_PREFIX.length));

async function candidates(): Promise<Candidate[]> {
  const d = await getDb();
  const notebooks = await d.select<{ id: string; title: string; cover: string; chat_bg: string; trashed_at: number }[]>(
    "SELECT id, title, cover, chat_bg, trashed_at FROM notebooks"
  );
  const nb = new Map(notebooks.map((n) => [n.id, n]));
  const whereOf = (id: string) => nb.get(id)?.title ?? "";
  const trashed = (id: string) => (nb.get(id)?.trashed_at ?? 0) > 0;
  const out: Candidate[] = [];

  const sources = await d.select<{ id: string; notebook_id: string; title: string; type: string; mime: string | null; refs: string; n: number }[]>(
    `SELECT id, notebook_id, title, type, mime,
            CASE WHEN instr(content, 'brewblob:') > 0 THEN content ELSE '' END AS refs,
            length(content) + length(text) AS n
       FROM sources`
  );
  for (const s of sources)
    out.push({
      id: `source:${s.id}`,
      kind: "source",
      rowId: s.id,
      label: `sources:${s.id}`,
      title: s.title,
      kindLabel: sourceLabel(s.type, s.mime, s.refs),
      where: whereOf(s.notebook_id),
      inTrash: trashed(s.notebook_id),
      files: names(s.refs),
      textBytes: s.n,
    });

  const artifacts = await d.select<{ id: string; notebook_id: string; title: string; kind: string; refs: string; n: number }[]>(
    `SELECT id, notebook_id, title, kind,
            CASE WHEN instr(data, 'brewblob:') > 0 THEN data ELSE '' END AS refs,
            length(data) AS n
       FROM artifacts`
  );
  for (const a of artifacts)
    out.push({
      id: `artifact:${a.id}`,
      kind: "artifact",
      rowId: a.id,
      label: `artifacts:${a.id}`,
      title: a.title,
      kindLabel: ARTIFACT_LABELS[a.kind] ?? "Studio output",
      where: whereOf(a.notebook_id),
      inTrash: trashed(a.notebook_id),
      files: names(a.refs),
      textBytes: a.n,
    });

  const images = await d.select<{ id: string; notebook_id: string; prompt: string; data: string }[]>(
    "SELECT id, notebook_id, prompt, data FROM images"
  );
  for (const i of images)
    out.push({
      id: `image:${i.id}`,
      kind: "image",
      rowId: i.id,
      label: `images:${i.id}`,
      title: i.prompt.trim().slice(0, 80) || "Generated image",
      kindLabel: "Generated image",
      where: whereOf(i.notebook_id),
      inTrash: trashed(i.notebook_id),
      files: names(i.data),
      textBytes: i.data.startsWith(BLOB_PREFIX) ? 200 : i.data.length,
    });

  for (const n of notebooks) {
    if (n.cover.includes(BLOB_PREFIX))
      out.push({ id: `cover:${n.id}`, kind: "cover", rowId: n.id, label: "", title: n.title, kindLabel: "Notebook cover", where: "", inTrash: n.trashed_at > 0, files: names(n.cover), textBytes: 0 });
    if (n.chat_bg.includes(BLOB_PREFIX))
      out.push({ id: `chat-bg:${n.id}`, kind: "chat-bg", rowId: n.id, label: "", title: n.title, kindLabel: "Chat background", where: "", inTrash: n.trashed_at > 0, files: names(n.chat_bg), textBytes: 0 });
  }
  const folders = await d.select<{ id: string; name: string; cover: string }[]>(
    "SELECT id, name, cover FROM folders WHERE instr(cover, 'brewblob:') > 0"
  );
  for (const f of folders)
    out.push({ id: `folder-cover:${f.id}`, kind: "folder-cover", rowId: f.id, label: "", title: f.name, kindLabel: "Folder cover", where: "", inTrash: false, files: names(f.cover), textBytes: 0 });

  return out;
}

/** A file's size on this device, without reading it (a one-byte range request); 0 if it isn't here. */
async function localFileSize(name: string): Promise<number> {
  try {
    if (platform.kind === "web" && (await platform.blobs.missing([name])).length > 0) return 0;
    const res = await fetch(mediaSrc(`${BLOB_PREFIX}${name}`), { headers: { range: "bytes=0-0" } });
    const total = /\/(\d+)$/.exec(res.headers.get("content-range") ?? "")?.[1];
    if (total) return Number(total);
    return Number(res.headers.get("content-length") ?? 0);
  } catch {
    return 0;
  }
}

/** The library's items, largest first; `synced` tells whether sizes are Sync's server-side counts. */
export async function largestItems(limit = 50): Promise<{ items: StorageItem[]; synced: boolean }> {
  const all = await candidates();
  const fileUse = new Map<string, number>();
  for (const c of all) for (const f of new Set(c.files)) fileUse.set(f, (fileUse.get(f) ?? 0) + 1);
  const fileNames = [...fileUse.keys()];
  const labels = all.map((c) => c.label).filter(Boolean);

  const server = await syncedSizes(fileNames, labels).catch(() => null);
  const fileSize = new Map<string, number>();
  if (server) for (const [n, b] of server.files) fileSize.set(n, b);
  else
    for (let i = 0; i < fileNames.length; i += 16) {
      const batch = fileNames.slice(i, i + 16);
      const sizes = await Promise.all(batch.map(localFileSize));
      batch.forEach((n, j) => fileSize.set(n, sizes[j]));
    }

  const items = all.map((c) => {
    const files = [...new Set(c.files)];
    const fileBytes = files.reduce((n, f) => n + (fileSize.get(f) ?? 0), 0);
    const rowBytes = server ? (c.label ? (server.rows.get(c.label) ?? 0) : 0) : c.textBytes;
    return {
      id: c.id,
      kind: c.kind,
      title: c.title || "Untitled",
      label: c.kindLabel,
      where: c.where,
      inTrash: c.inTrash,
      bytes: fileBytes + rowBytes,
      shared: files.some((f) => (fileUse.get(f) ?? 0) > 1),
    };
  });
  items.sort((a, b) => b.bytes - a.bytes);
  return { items: items.filter((i) => i.bytes > 0).slice(0, limit), synced: !!server };
}

/** Delete one item everywhere (it syncs like any delete), then free the space it used. */
export async function deleteStorageItem(item: StorageItem): Promise<void> {
  const rowId = item.id.slice(item.kind.length + 1);
  if (item.kind === "source") await deleteSource(rowId);
  else if (item.kind === "artifact") await deleteArtifact(rowId);
  else if (item.kind === "image") await deleteImage(rowId);
  else if (item.kind === "cover") await setNotebookCover(rowId, "");
  else if (item.kind === "chat-bg") await setNotebookChatBg(rowId, "");
  else if (item.kind === "folder-cover") await setFolderCover(rowId, "");
  // This device's copy of files nothing uses any more (after the usual short wait),
  // and the server's: Sync sweeps once the delete has gone up.
  void pruneOrphanBlobs().catch(() => {});
  requestStorageSweep();
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}
