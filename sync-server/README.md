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
POST   /v1/billing/checkout            { plan, interval } or { plan: "topup" } → { url }   (Polar)
POST   /v1/billing/change              { plan, interval } → { when: "now"|"renewal" }
POST   /v1/billing/portal              → { url }
POST   /v1/webhooks/polar              Standard Webhooks-signed subscription and order events

GET    /v1/ai/config                   public: which model does each job (src/aiConfig.ts)
POST   /v1/ai/key                      the account's capped OpenRouter key (Pro/Max)
GET    /v1/ai/usage                    → { usedFraction, resetsAt, left: { chats, audioOverviews, … } }

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

POST   /v1/shares                      shared notebook links (src/shares.ts): create, then
PUT    /v1/shares/:id/blobs/:blob      upload encrypted files and the snapshot
PUT    /v1/shares/:id/manifest?expect=<version>
GET    /v1/shares/:id[/manifest|/blobs/:blob]   public: anyone with the link
POST   /v1/shares/:id/report           public: { reason } → emailed to REPORT_EMAIL
POST   /v1/admin/shares/:id            ADMIN_TOKEN: { disabled } takes a link down
```

Shared links are encrypted with a key only the link carries (after `#`), so
the server can't read them either. They count against the owner's storage;
an hourly cron deletes expired and never-published ones, and a link pauses
30 days after its owner's plan ends.

Blobs live in R2: media files and records too big for the change log, whose
change then carries only a pointer. The key envelope holds the vault key
wrapped by the user's password (Argon2id) and by their recovery key; the
server stores it but can't open it. A device link is the vault key sealed with a one-time
secret that only the QR code carries, stored under an id derived from it.

Accounts: email sign-in links (the app polls while you confirm in the
browser; opening the link alone never signs in), a 14-day trial without a
card, then Sync (10 GB) or Sync Plus (100 GB) through Polar, or Pro (10 GB) and
Max (100 GB) with BrewLM AI included. An account has one subscription:
`/v1/billing/change` switches it, upgrading now (Polar charges the prorated
difference first) and downgrading at renewal. Without a plan or
trial a vault is read-only (402 on uploads); uploads past the limit get 413.
The limit is checked inside the vault's Durable Object on every write, one
at a time, so parallel uploads can't share the same free space: an upload
counts in full from the moment it's let in, R2 stores exactly the bytes
counted, and any file found in R2 that isn't counted starts counting.
Records count their key and a fixed overhead too. Every pull, push, upload
and sweep returns `usedBytes`, so the app's storage figure is always current.

BrewLM AI (src/ai.ts): each Pro/Max account gets a monthly allowance in
dollars of OpenRouter credit (src/aiConfig.ts), spent through an OpenRouter
key this server creates with that limit (src/openrouter.ts) and stores
encrypted. Months are calendar months (UTC): the first is prorated, a plan
change adds or removes the difference, a lapsed plan's key is deleted, and
every key is replaced at the start of a month. Spending is tracked per
account, so a new key only gets what's left. Top-ups (a one-time Polar
product) add credit that carries over while the plan lasts. The hourly cron
grants, revokes and rolls over; webhooks do it right away.

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
ids. For BrewLM AI, set `OPENROUTER_MANAGEMENT_KEY` (a management key, with
an expiry date) and `AI_KEY_SECRET` (any long random string; never change it
once keys exist). After changing `wrangler.jsonc`, run `npm run types`.

To watch two copies of BrewLM sync on one machine, run the app with
`npm run tauri dev` and then `scripts/sync-dev-copy.sh a` and
`scripts/sync-dev-copy.sh b` from the repo root (shared dev token, no
account). To try accounts, run a copy without the token:
`BREWLM_PROFILE=d BREWLM_SYNC_URL=http://127.0.0.1:8787 src-tauri/target/debug/brewlm`.

The web app (`npm run dev:web`, http://localhost:1430) syncs when
`VITE_SYNC_URL` is set, e.g. in a git-ignored `.env.web.local` at the repo
root (`VITE_SYNC_TOKEN` and `VITE_SYNC_VAULT` work like the desktop dev
variables). `CORS_ORIGINS` lists the web origins the server answers; add
others to `.dev.vars` for local testing.

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
npx wrangler secret put OPENROUTER_MANAGEMENT_KEY    # BrewLM AI
npx wrangler secret put AI_KEY_SECRET
```

Set the `POLAR_PRODUCT_*` ids in `wrangler.jsonc` (they're public; an empty
one isn't for sale), then `npm run deploy`. Cloudflare attaches
`sync.brewlm.com` and its certificate. In Polar, add a webhook to
`https://sync.brewlm.com/v1/webhooks/polar` for the `subscription.*` events
and `order.paid`, `order.updated` and `order.refunded` (AI top-ups). Never set
`SYNC_DEV_TOKEN` in production (the server ignores it there anyway).

Polar settings for BrewLM AI: give Pro and Max a trial on the product (it
asks for a card), turn on **Prevent trial abuse**, and turn off plan changes
in the customer portal (the app changes plans through `/v1/billing/change`,
which charges upgrades before they apply). Refunding a subscription order
doesn't stop its AI: revoke the subscription for that (Polar does when it
refunds to head off a chargeback).

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
The web app (milestone 3b) uses the same API from the browser: CORS allows
https://app.brewlm.com. Since 3d it also asks `POST /v1/fetch` to read web
pages and YouTube transcripts it can't read itself (src/fetch.ts: public
http(s) addresses only, 25 MB, 120 an hour per account). Files nothing
points to any more are deleted when an up-to-date device sends the list of
files it uses (`blobs/sweep`), right after a delete and every few hours.
Still to come: live updates (WebSocket).

## License

This server is released under the GNU Affero General Public License v3.0
(AGPL-3.0-only); see `LICENSE`. If you run a modified copy where others can
reach it over a network, you must offer them its source. Versions before this
change were released under Apache 2.0. The rest of BrewLM (the app and its
sync client) is Apache 2.0; see the root `LICENSE`.
