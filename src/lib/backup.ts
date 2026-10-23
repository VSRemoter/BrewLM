/**
 * Backup & restore for the local-first data store.
 *
 * Data lives in one SQLite file (`brewlm.db` in the app data dir) plus the
 * media files it references (`blobs/`, see blobs.ts). A backup is a zip of
 * both, written by Rust (`backup_export`). The DB runs in WAL mode, so exports
 * checkpoint first (folding -wal/-shm sidecars into the main file) and
 * imports truncate stale sidecars before the swap. Older `.db` backups (from
 * before media moved to files) still restore — their media is inline.
 */
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { appDataDir, join } from "@tauri-apps/api/path";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { checkpointWal, clearAllData, closeDb } from "./db";

export async function dbFilePath(): Promise<string> {
  return join(await appDataDir(), "brewlm.db");
}

/** Save a backup to a user-picked location. Returns the path, or null if cancelled. */
export async function exportBackup(): Promise<string | null> {
  const stamp = new Date().toISOString().slice(0, 10);
  const dest = await save({
    defaultPath: `brewlm-backup-${stamp}.zip`,
    filters: [{ name: "BrewLM backup", extensions: ["zip"] }],
  });
  if (!dest) return null;
  await exportBackupTo(dest);
  return dest;
}

/** Write the backup zip (database + media files) to `dest`. */
export async function exportBackupTo(dest: string): Promise<void> {
  // Fold WAL sidecars into the main file so the copy is complete on its own.
  await checkpointWal();
  await invoke("backup_export", { dest });
}

/** Reveal the folder holding brewlm.db in the OS file manager. */
export async function revealDataFolder(): Promise<void> {
  await revealItemInDir(await dbFilePath());
}

/**
 * Replace the database with a user-picked backup, then reload the window.
 * Callers must confirm with the user first — this destroys current data —
 * and refuse while phone sharing is active (the Rust side holds the file).
 */
export async function importBackup(): Promise<boolean> {
  const picked = await open({
    multiple: false,
    filters: [{ name: "BrewLM backup", extensions: ["zip", "db"] }],
  });
  if (!picked || typeof picked !== "string") return false;
  await importBackupFrom(picked);
  window.location.reload();
  return true;
}

/**
 * Replace the database (and add the media files) from a `.zip` backup, or an
 * older `.db` one. Throws with the current data intact if the file can't be
 * restored; the caller reloads the window on success.
 */
export async function importBackupFrom(picked: string): Promise<void> {
  const isZip = picked.toLowerCase().endsWith(".zip");
  const bytes = isZip ? null : await readFile(picked);
  const path = await dbFilePath();
  // Fold the WAL into the main file first: truncating the sidecars below then
  // loses nothing, even if the restore fails and the current database stays.
  await checkpointWal();
  await closeDb();
  // Stale WAL sidecars from the old database must not replay into the new
  // file — truncate them (fs:allow-remove isn't granted, so no unlink).
  const empty = new Uint8Array(0);
  await writeFile(`${path}-wal`, empty).catch(() => {});
  await writeFile(`${path}-shm`, empty).catch(() => {});
  // A zip restore checks the archive before replacing anything; on failure the
  // next getDb() simply reopens the untouched database.
  if (isZip) await invoke("backup_restore_zip", { src: picked });
  else await writeFile(path, bytes!);
}

/** Wipe every table (notebooks, sources, chats, studio, settings, usage), then reload. */
export async function factoryReset(): Promise<void> {
  await clearAllData();
  window.location.reload();
}
