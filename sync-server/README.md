# BrewLM Sync server

A Cloudflare Worker that relays a user's library between their devices. Each
vault (one user's library) is a Durable Object holding the newest version of
every record; devices push changes and pull everything after their cursor.
Records are opaque to the server (end-to-end encrypted from milestone 2c).

```
POST /v1/vaults/:vault/push            { device, changes: [{ key, hlc, payload }] }
GET  /v1/vaults/:vault/pull?since=<seq>&limit=<n>
POST /v1/vaults/:vault/blobs/missing   { ids } → { missing }
PUT  /v1/vaults/:vault/blobs/:id       (raw bytes, up to 100 MB)
GET  /v1/vaults/:vault/blobs/:id
```

Blobs live in R2: media files (named by their SHA-256, so devices verify
every download) and records too big for the change log, whose change then
carries only a pointer.

Conflicts are last-writer-wins on each change's hybrid logical clock
(`<ms>:<counter>:<device>`), checked here and again on the device
(`src-tauri/src/sync.rs`). The desktop engine is `src/lib/sync.ts`.

## Develop

```bash
npm install
cp .dev.vars.example .dev.vars   # then set SYNC_DEV_TOKEN
npm run dev                      # http://127.0.0.1:8787, data in .wrangler/
npm test                         # runs in the Workers runtime (Miniflare)
npm run typecheck
```

No Cloudflare account is needed for any of this. After changing
`wrangler.jsonc`, run `npm run types`.

To watch two copies of BrewLM sync on one machine, run the app with
`npm run tauri dev` and then `scripts/sync-dev-copy.sh a` and
`scripts/sync-dev-copy.sh b` from the repo root.

## Status

Milestones 2a–2b: records and media files sync, one shared dev token, polling
every 3 s. Still to come: encryption (2c), linking a device (2d), accounts,
billing, quotas and cleanup of unused server blobs (2e), deployment (2f).
