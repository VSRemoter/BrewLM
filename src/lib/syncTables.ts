/**
 * Tables BrewLM Sync replicates, with their primary key column (mirrored in
 * src-tauri/src/sync.rs). Its own module so the web database worker can use
 * it without the rest of db.ts.
 */
export const SYNCED_TABLES: Record<string, string> = {
  notebooks: "id",
  folders: "id",
  sources: "id",
  chats: "id",
  messages: "id",
  artifacts: "id",
  images: "id",
  // Machine-specific keys (local model server…) get filtered at push time.
  settings: "key",
  usage_events: "id",
};
