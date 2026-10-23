# BrewLM Sync server

A Cloudflare Worker that relays a user's library between their devices. Each
vault (one user's library) is a Durable Object holding the newest version of
every record; devices push changes and pull everything after their cursor.
Everything is end-to-end encrypted on the device (`src/lib/vaultCrypto.ts`):
the server sees hidden ids, ciphertext, sizes and timing — never content,
table names, or which file is which.

```
POST /v1/vaults/:vault/push            { device, changes: [{ key, hlc, payload }] }
GET  /v1/vaults/:vault/pull?since=<seq>&limit=<n>
GET  /v1/vaults/:vault/keys            → { envelope, version }
PUT  /v1/vaults/:vault/keys            { envelope, expectVersion }   (409 if stale)
PUT  /v1/vaults/:vault/links/:id       { sealed }   (one-time device link, 10 min)
GET  /v1/vaults/:vault/links/:id       → { sealed }   (deleted as it's read)
GET  /v1/vaults/:vault/links/:id/status → { pending }
DELETE /v1/vaults/:vault/links/:id
POST /v1/vaults/:vault/blobs/missing   { ids } → { missing }
PUT  /v1/vaults/:vault/blobs/:id       (raw bytes, up to 100 MB)
GET  /v1/vaults/:vault/blobs/:id
```

Blobs live in R2: media files and records too big for the change log, whose
change then carries only a pointer. The key envelope holds the vault key
wrapped by the user's password (Argon2id) and by their recovery key; the
server stores it but can't open it. A device link is the vault key sealed with a one-time
secret that only the QR code carries, stored under an id derived from it.

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

Milestones 2a–2d: end-to-end encrypted records and media sync, and linking a
new device with a one-time QR/typed code instead of the password; one shared
dev token, polling every 3 s. Still to come: accounts, billing, quotas and
cleanup of unused server blobs (2e), deployment (2f).
