/** The Tauri desktop app's platform (see types.ts). */
import { getVersion } from "@tauri-apps/api/app";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";
import Database from "@tauri-apps/plugin-sql";
import { load, type Store } from "@tauri-apps/plugin-store";
import type { Platform, SyncServerConfig } from "./types";

let store: Promise<Store> | null = null;
/** This install's settings file: device id and vault key, never in the database or backups. */
const deviceStore = () => (store ??= load("sync-device.json", { autoSave: false, defaults: {} }));

export const platform: Platform = {
  kind: "desktop",
  ready: async () => {},

  openDb: () => Database.load("sqlite:brewlm.db"),
  // Rust-side HTTP: no CORS, so providers and web pages that don't allow browsers still work.
  fetch: (url, init) => tauriFetch(url, init),
  openUrl: (url) => openUrl(url),
  appVersion: () => getVersion(),

  async saveFile({ defaultName, filters, data }) {
    const path = await save({ defaultPath: defaultName, filters });
    if (!path) return null;
    if (typeof data === "string") await writeTextFile(path, data);
    else await writeFile(path, data);
    return path;
  },
  async pickFile({ filters }) {
    const path = await open({ multiple: false, filters });
    if (!path) return null;
    return { name: path.split(/[\\/]/).pop() ?? "file", bytes: await readFile(path) };
  },

  kv: {
    get: async (key) => (await deviceStore()).get(key),
    async set(key, value) {
      const s = await deviceStore();
      await s.set(key, value);
      await s.save();
    },
    async delete(key) {
      const s = await deviceStore();
      await s.delete(key);
      await s.save();
    },
  },

  blobs: {
    put: (bytes, ext) => invoke<string>("blob_put", bytes, { headers: { "x-blob-ext": ext } }),
    url: (name) => convertFileSrc(name, "brewblob"),
    missing: (names) => invoke<string[]>("blob_missing", { names }),
    gc: (keep, graceMs) => invoke("blob_gc", { keep, graceMs }),
  },

  // plugin-sql pools connections, so a multi-statement transaction can't be
  // held from here: Rust writes pulled changes on its own connection (sync.rs).
  sync: {
    apply: (deviceId, changes) => invoke("sync_apply", { deviceId, changes }),
    markPushed: (pushed) => invoke("sync_mark_pushed", { pushed }),
    config: () => invoke<SyncServerConfig | null>("sync_config"),
    log: (line) => void invoke("sync_log", { line }).catch(() => {}),
  },

  onMenu(handler) {
    const off = listen<string>("menu", (e) => handler(e.payload));
    return () => void off.then((f) => f());
  },
};
