# BrewLM Sync server

A Cloudflare Worker that relays a user's library between their devices. Each
account (D1) owns one vault: a Durable Object holding the newest version of
every record; devices push changes and pull everything after their cursor.
Everything is end-to-end encrypted on the device (`src/lib/vaultCrypto.ts`):
the server sees hidden ids, ciphertext, sizes and timing — never content,
table names, or which file is which.

```
POST   /v1/auth/start                  { email } → { pendingId, code }   (emails a sign-in link)
GET    /v1/auth/verify?token=          confirm page; POST (its button) approves
POST   /v1/auth/poll                   { pendingId } → { status, session?, vault? }
DELETE /v1/auth/session
GET    /v1/me                          → plan, trial, storage used/limit
POST   /v1/billing/checkout            { plan, interval } → { url }   (Polar)
POST   /v1/billing/portal              → { url }
POST   /v1/webhooks/polar              Standard Webhooks-signed subscription events

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

Accounts: email sign-in links (the app polls while you confirm in the
browser; opening the link alone never signs in), a 14-day trial without a
card, then Sync (10 GB) or Sync Plus (100 GB) through Polar. Without a plan or
trial a vault is read-only (402 on uploads); uploads past the limit get 413.

Conflicts are last-writer-wins on each change's hybrid logical clock
(`<ms>:<counter>:<device>`), checked here and again on the device
(`src-tauri/src/sync.rs`). The desktop engine is `src/lib/sync.ts`.

## Develop

```bash
npm install
cp .dev.vars.example .dev.vars   # then set SYNC_DEV_TOKEN (and optional keys)
npx wrangler d1 migrations apply brewlm-sync --local   # account tables
npm run dev                      # http://127.0.0.1:8787, data in .wrangler/
npm test                         # runs in the Workers runtime (Miniflare)
npm run typecheck
```

No Cloudflare account is needed for any of this. Without `RESEND_API_KEY`
sign-in links are printed to this console. For billing in Polar's sandbox,
set `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET` and the `POLAR_PRODUCT_*`
ids. After changing `wrangler.jsonc`, run `npm run types`.

To watch two copies of BrewLM sync on one machine, run the app with
`npm run tauri dev` and then `scripts/sync-dev-copy.sh a` and
`scripts/sync-dev-copy.sh b` from the repo root (shared dev token, no
account). To try accounts, run a copy without the token:
`BREWLM_PROFILE=d BREWLM_SYNC_URL=http://127.0.0.1:8787 src-tauri/target/debug/brewlm`.

## Deploy (https://sync.brewlm.com)

One-time setup, from `sync-server/`:

```bash
npx wrangler login                                   # opens Cloudflare in the browser
npx wrangler r2 bucket create brewlm-sync-blobs
npx wrangler d1 create brewlm-sync                   # paste its database_id into wrangler.jsonc
npm run migrate:remote                               # account tables
npx wrangler secret put RESEND_API_KEY               # each prompts for the value
npx wrangler secret put POLAR_ACCESS_TOKEN
npx wrangler secret put POLAR_WEBHOOK_SECRET
```

Set the four `POLAR_PRODUCT_*` ids in `wrangler.jsonc` (they're public), then
`npm run deploy`. Cloudflare attaches `sync.brewlm.com` and its certificate.
In Polar, add a webhook to `https://sync.brewlm.com/v1/webhooks/polar` for the
`subscription.*` events. Never set `SYNC_DEV_TOKEN` in production (the server
ignores it there anyway).

Production uses live Polar (`api.polar.sh`) and the live products in
`wrangler.jsonc`; `.dev.vars` points local development at Polar's sandbox.
To test a purchase in production without paying, use a 100%-off discount code.
After a schema change, `npm run migrate:remote` before `npm run deploy`.

## Status

Milestones 2a–2f: end-to-end encrypted records and media, device linking by
one-time code, accounts with email sign-in, a 14-day trial, Polar plans,
storage limits, and the production setup above. Release builds of the app
sync with https://sync.brewlm.com: uploads go out within seconds, other
devices' changes are fetched every 30 s and when the window regains focus.
Still to come: live updates (WebSocket) and cleaning up server files nothing
points to any more.
