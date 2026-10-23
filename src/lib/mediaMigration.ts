/**
 * One-time move of inline media into the file store (blobs.ts), compressing
 * WAV audio overviews to AAC on the way (audioEncode.ts).
 *
 * Runs in the background after launch, one row at a time, and is idempotent:
 * an interrupted run resumes on the next launch. Compressing audio is the one
 * lossy step, so a snapshot of the database (`brewlm.db.before-media-move`,
 * kept 30 days) is taken first; without it, WAVs are left for a later launch. Rows are rewritten in place
 * without touching updated_at, and each update is guarded on the old value so
 * an edit made meanwhile wins. Afterwards unused files are swept and the
 * database is VACUUMed so the file on disk actually shrinks.
 */
import { invoke } from "@tauri-apps/api/core";
import { compressWav } from "./audioEncode";
import { isBlobRef, mediaBytes, putBlob, storeMedia } from "./blobs";
import { getDb, pruneOrphanBlobs } from "./db";

/** Reclaim space once at least this much of the database file is free pages. */
const VACUUM_FREE_BYTES = 32 * 1024 * 1024;

let running: Promise<void> | null = null;

export function migrateMedia(): Promise<void> {
  return (running ??= run().finally(() => (running = null)));
}

async function run(): Promise<void> {
  const d = await getDb();
  const wavPending = async () =>
    (await d.select<{ n: number }[]>(
      "SELECT count(*) AS n FROM artifacts WHERE kind = 'audio' AND instr(data, 'data:audio/wav') > 0"
    ))[0]?.n > 0;
  // Snapshot before anything changes, so it holds the library exactly as it was.
  let canCompress = false;
  if (await wavPending()) {
    try {
      const path = await invoke<string>("snapshot_before_media_move");
      canCompress = true;
      console.info(`media: safety copy saved before compressing audio — ${path}`);
    } catch (e) {
      console.warn("media: no safety copy (WAV audio left as-is until next launch):", e);
    }
  }
  let moved = 0;
  let audioBefore = 0;
  let audioAfter = 0;

  // Covers, chat backgrounds, image/audio sources: data URL → reference.
  for (const [table, col] of [
    ["notebooks", "cover"],
    ["notebooks", "chat_bg"],
    ["folders", "cover"],
    ["sources", "content"],
  ] as const) {
    const ids = await d.select<{ id: string }[]>(`SELECT id FROM ${table} WHERE ${col} LIKE 'data:%'`);
    for (const { id } of ids) {
      const [row] = await d.select<{ v: string }[]>(`SELECT ${col} AS v FROM ${table} WHERE id = $1`, [id]);
      if (!row?.v.startsWith("data:")) continue;
      const ref = await storeMedia(row.v);
      if (ref === row.v) continue; // unknown format or save failed: stays inline
      await d.execute(`UPDATE ${table} SET ${col} = $1 WHERE id = $2 AND ${col} = $3`, [ref, id, row.v]);
      moved++;
    }
  }

  // Generated-image library: raw base64 + mime → reference.
  const images = await d.select<{ id: string }[]>("SELECT id FROM images WHERE data NOT LIKE 'brewblob:%'");
  for (const { id } of images) {
    const [row] = await d.select<{ mime: string; data: string }[]>("SELECT mime, data FROM images WHERE id = $1", [id]);
    if (!row || isBlobRef(row.data)) continue;
    const ref = await storeMedia(`data:${row.mime};base64,${row.data}`);
    if (!isBlobRef(ref)) continue;
    await d.execute("UPDATE images SET data = $1 WHERE id = $2 AND data NOT LIKE 'brewblob:%'", [ref, id]);
    moved++;
  }

  // Audio overviews: WAV → AAC .m4a where possible, then into the store.
  const audio = await d.select<{ id: string }[]>(
    "SELECT id FROM artifacts WHERE kind = 'audio' AND instr(data, 'data:audio/') > 0"
  );
  for (const { id } of audio) {
    const [row] = await d.select<{ data: string }[]>("SELECT data FROM artifacts WHERE id = $1", [id]);
    if (!row) continue;
    let parsed: { audio?: unknown };
    try {
      parsed = JSON.parse(row.data);
    } catch {
      continue;
    }
    const inline = parsed.audio;
    if (typeof inline !== "string" || !inline.startsWith("data:audio/")) continue;
    let ref = "";
    if (inline.startsWith("data:audio/wav")) {
      if (!canCompress) continue; // stays inline; retried with a snapshot next launch
      try {
        const wav = await mediaBytes(inline);
        const m4a = await compressWav(wav);
        if (m4a) {
          ref = await putBlob(m4a, "m4a");
          audioBefore += wav.length;
          audioAfter += m4a.length;
        }
      } catch (e) {
        console.warn("media: couldn't compress audio, storing as-is", id, e);
      }
    }
    if (!ref) ref = await storeMedia(inline);
    if (!isBlobRef(ref)) continue;
    await d.execute("UPDATE artifacts SET data = $1 WHERE id = $2 AND data = $3", [
      JSON.stringify({ ...parsed, audio: ref }),
      id,
      row.data,
    ]);
    moved++;
  }

  if (moved > 0) {
    const saved = audioBefore > 0 ? `; audio ${(audioBefore / 1e6).toFixed(0)} → ${(audioAfter / 1e6).toFixed(0)} MB` : "";
    console.info(`media: moved ${moved} file(s) out of the database${saved}`);
  }
  await pruneOrphanBlobs();
  // The snapshot goes once it's 30 days old and no audio still needs it.
  if (!(await wavPending())) await invoke("prune_media_snapshot").catch(() => {});

  const [free] = await d.select<{ bytes: number }[]>(
    "SELECT (SELECT freelist_count FROM pragma_freelist_count()) * (SELECT page_size FROM pragma_page_size()) AS bytes"
  );
  if ((free?.bytes ?? 0) >= VACUUM_FREE_BYTES) {
    try {
      await d.execute("VACUUM");
      // VACUUM rewrites every page through the WAL; fold it back and shrink the sidecar.
      await d.execute("PRAGMA wal_checkpoint(TRUNCATE)");
      console.info(`media: database compacted, ${((free?.bytes ?? 0) / 1e6).toFixed(0)} MB reclaimed`);
    } catch (e) {
      console.warn("media: VACUUM skipped (database busy) — retrying next launch", e);
    }
  }
}
