/**
 * What BrewLM needs from the place it runs. Two builds implement it:
 *
 * - desktop.ts — the Tauri app: SQLite through plugin-sql, media files and
 *   sync writes in Rust, native dialogs, CORS-free HTTP.
 * - web.ts — a browser (the phone app): SQLite compiled to WebAssembly in a
 *   worker, stored in the origin-private file system; media in Cache Storage
 *   served by a service worker; downloads and file inputs instead of dialogs.
 *
 * The build picks one through the `@platform-impl` alias (vite.config.ts), so
 * neither build ships the other's code. Everything else imports `platform`
 * from "./index".
 */

export interface SqlResult {
  rowsAffected: number;
  lastInsertId?: number;
}

/** plugin-sql's interface; `$1`, `$2`… bind to `bind[0]`, `bind[1]`… */
export interface SqlDb {
  execute(sql: string, bind?: unknown[]): Promise<SqlResult>;
  select<T>(sql: string, bind?: unknown[]): Promise<T>;
  close(): Promise<unknown>;
}

/** `fetch` options; `connectTimeout` (ms) is honoured where the platform can. */
export interface HttpInit extends RequestInit {
  connectTimeout?: number;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface PickedFile {
  name: string;
  bytes: Uint8Array;
}

/** A change pulled from the sync server, decrypted (see lib/sync.ts). */
export interface RemoteChange {
  tbl: string;
  row_id: string;
  hlc: string;
  deleted: boolean;
  row?: Record<string, unknown> | null;
}

/** A pushed outbox entry: `hlc` null means the server held a newer version. */
export interface PushedChange {
  tbl: string;
  row_id: string;
  changed_at: number;
  hlc: string | null;
}

export interface SyncServerConfig {
  url: string;
  token?: string | null;
  vault?: string;
  password?: string | null;
}

export interface Platform {
  kind: "desktop" | "web";
  /** Resolves once the platform can serve the app (the web build's service worker). */
  ready(): Promise<void>;

  openDb(): Promise<SqlDb>;
  fetch(url: string, init?: HttpInit): Promise<Response>;
  openUrl(url: string): Promise<void>;
  appVersion(): Promise<string>;

  /** Save dialog (desktop) or a download (web). Resolves to where it went, or null if cancelled. */
  saveFile(opts: { defaultName: string; filters?: FileFilter[]; data: Uint8Array | string }): Promise<string | null>;
  pickFile(opts: { filters?: FileFilter[] }): Promise<PickedFile | null>;

  /** Small per-install values kept outside the database (device id, vault key). */
  kv: {
    get<T>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };

  /** Content-addressed media files; names are `<sha256>.<ext>` (see lib/blobs.ts). */
  blobs: {
    put(bytes: Uint8Array, ext: string): Promise<string>;
    /** A URL <img>/<audio>/fetch can load. */
    url(name: string): string;
    missing(names: string[]): Promise<string[]>;
    gc(keep: string[], graceMs: number): Promise<{ removed: number; freed_bytes: number }>;
    /**
     * Web only: called when a file is opened that this device doesn't have;
     * `fetch` downloads it (Sync) and resolves true once it's stored.
     */
    onMissing?(fetch: (name: string) => Promise<boolean>): void;
  };

  sync: {
    /** Write pulled changes in one transaction with change tracking silenced. */
    apply(deviceId: string, changes: RemoteChange[]): Promise<{ applied: number[] }>;
    markPushed(pushed: PushedChange[]): Promise<void>;
    config(): Promise<SyncServerConfig | null>;
    log(line: string): void;
  };
}
