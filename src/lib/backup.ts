/**
 * Backup & restore for the local-first data store.
 *
 * Everything lives in one SQLite file (`brewlm.db` in the app data dir). The
 * DB runs in WAL mode, so exports checkpoint first (folding -wal/-shm sidecars
 * into the main file) and imports truncate stale sidecars before the swap.
 */
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { appDataDir, join } from "@tauri-apps/api/path";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { checkpointWal, clearAllData, closeDb } from "./db";

export async function dbFilePath(): Promise<string> {
  return join(await appDataDir(), "brewlm.db");
}

/** Copy the database to a user-picked location. Returns the path, or null if cancelled. */
export async function exportBackup(): Promise<string | null> {
  // Fold WAL sidecars into the main file so the copy is complete on its own.
  await checkpointWal();
  const stamp = new Date().toISOString().slice(0, 10);
  const dest = await save({
    defaultPath: `brewlm-backup-${stamp}.db`,
    filters: [{ name: "BrewLM backup", extensions: ["db"] }],
  });
  if (!dest) return null;
  const bytes = await readFile(await dbFilePath());
  await writeFile(dest, bytes);
  return dest;
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
    filters: [{ name: "BrewLM backup", extensions: ["db"] }],
  });
  if (!picked || typeof picked !== "string") return false;
  const bytes = await readFile(picked);
  const path = await dbFilePath();
  await closeDb();
  // Stale WAL sidecars from the old database must not replay into the new
  // file — truncate them (fs:allow-remove isn't granted, so no unlink).
  const empty = new Uint8Array(0);
  await writeFile(`${path}-wal`, empty).catch(() => {});
  await writeFile(`${path}-shm`, empty).catch(() => {});
  await writeFile(path, bytes);
  window.location.reload();
  return true;
}

/** Wipe every table (notebooks, sources, chats, studio, settings, usage), then reload. */
export async function factoryReset(): Promise<void> {
  await clearAllData();
  window.location.reload();
}
