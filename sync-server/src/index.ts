/**
 * BrewLM Sync server (Cloudflare Worker).
 *
 * Accounts (auth.ts, billing.ts — D1):
 *   POST   /v1/auth/start            { email } → { pendingId, code, expiresAt }   (emails a link)
 *   GET    /v1/auth/verify?token=    confirm page;  POST (its button) approves
 *   POST   /v1/auth/poll             { pendingId } → { status, session?, email?, vault? }
 *   DELETE /v1/auth/session          sign this device out
 *   GET    /v1/me                    → { email, vault, plan, canSync, limitBytes, usedBytes, … }
 *   POST   /v1/billing/checkout      { plan, interval } → { url }   (Polar-hosted)
 *   POST   /v1/billing/portal        → { url }
 *   GET    /v1/billing/done          "return to BrewLM" page
 *   POST   /v1/webhooks/polar        subscription updates from Polar
 *
 * A vault (one user's library, a Durable Object + R2 prefix):
 *   POST /v1/vaults/:vault/push   { device, changes: [{ key, hlc, payload }] }
 *   GET  /v1/vaults/:vault/pull?since=<seq>&limit=<n>
 *   GET  /v1/vaults/:vault/keys            → { envelope, version }
 *   PUT  /v1/vaults/:vault/keys            { envelope, expectVersion } (409 if stale)
 *   PUT  /v1/vaults/:vault/links/:id       { sealed } → { expires }  (one-time, 10 min)
 *   GET  /v1/vaults/:vault/links/:id       → { sealed }  (deleted as it's read)
 *   GET  /v1/vaults/:vault/links/:id/status → { pending }
 *   DELETE /v1/vaults/:vault/links/:id
 *   POST /v1/vaults/:vault/blobs/missing   { ids } → { missing }
 *   PUT  /v1/vaults/:vault/blobs/:id       (raw bytes)
 *   GET  /v1/vaults/:vault/blobs/:id
 *
 * Vault requests carry a session token (the vault must be the user's own) or,
 * for local development, SYNC_DEV_TOKEN (any vault, no limits). Uploads need
 * an active plan or trial and stay within its storage limit (402 / 413);
 * reads always work, so a lapsed account can still download its library.
 * `Env` is generated from wrangler.jsonc by `npm run types`.
 */
import { pollSignIn, signOut, startSignIn, userForSession, verifySignIn, type User } from "./auth";
import { billingDone, checkout, entitlement, polarWebhook, portal } from "./billing";
import { HLC_RE, MAX_ENVELOPE, MAX_KEY, MAX_PAYLOAD, MAX_PULL, MAX_PUSH, type Change, Vault } from "./vault";

export { Vault };

const VAULT_RE = /^[a-z0-9-]{1,64}$/;
const BLOB_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Workers accept request bodies up to 100 MB. */
const MAX_BLOB = 100 * 1024 * 1024;
const MAX_MISSING = 1000;
const UUID_RE = /^[0-9a-f-]{36}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const fail = (status: number, error: string) => json({ error }, status);

const bearer = (req: Request) => req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";

/**
 * The shared dev token skips accounts entirely, so it only counts on a local
 * server — never on the deployed one, even if the secret were set by mistake.
 */
export function isDevToken(req: Request, env: Env): boolean {
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(env.PUBLIC_URL)) return false;
  const token = env.SYNC_DEV_TOKEN;
  const given = bearer(req);
  if (!token || given.length !== token.length) return false;
  const enc = new TextEncoder();
  return crypto.subtle.timingSafeEqual(enc.encode(given), enc.encode(token));
}

/** Who is calling a vault route, and what they may do there. */
interface Caller {
  canWrite: boolean;
  limitBytes: number;
}

async function vaultCaller(req: Request, env: Env, vault: string): Promise<Caller | Response> {
  if (isDevToken(req, env)) return { canWrite: true, limitBytes: Number.MAX_SAFE_INTEGER };
  const user = await userForSession(env, bearer(req));
  if (!user) return fail(401, "unauthorized");
  if (user.id !== vault) return fail(403, "not your vault");
  const ent = await entitlement(env, user);
  return { canWrite: ent.canSync, limitBytes: ent.limitBytes };
}

const NO_PLAN = "Your free trial has ended. Choose a plan to keep syncing; your library can still be downloaded.";

function validChanges(v: unknown): v is Change[] {
  return (
    Array.isArray(v) &&
    v.length <= MAX_PUSH &&
    v.every(
      (c) =>
        c &&
        typeof c.key === "string" &&
        c.key.length > 0 &&
        c.key.length <= MAX_KEY &&
        typeof c.hlc === "string" &&
        HLC_RE.test(c.hlc) &&
        typeof c.payload === "string" &&
        c.payload.length <= MAX_PAYLOAD
    )
  );
}

async function accountRoutes(req: Request, env: Env, path: string): Promise<Response | null> {
  if (path === "/v1/auth/start" && req.method === "POST") return startSignIn(req, env);
  if (path === "/v1/auth/verify" && (req.method === "GET" || req.method === "POST")) return verifySignIn(req, env);
  if (path === "/v1/auth/poll" && req.method === "POST") return pollSignIn(req, env);
  if (path === "/v1/billing/done" && req.method === "GET") return billingDone();
  if (path === "/v1/webhooks/polar" && req.method === "POST") return polarWebhook(req, env);

  const signedIn = ["/v1/auth/session", "/v1/me", "/v1/billing/checkout", "/v1/billing/portal"];
  if (!signedIn.includes(path)) return null;
  const user = await userForSession(env, bearer(req));
  if (!user) return fail(401, "unauthorized");
  if (path === "/v1/auth/session" && req.method === "DELETE") return signOut(env, bearer(req));
  if (path === "/v1/me" && req.method === "GET") return me(env, user);
  if (path === "/v1/billing/checkout" && req.method === "POST") return checkout(req, env, user);
  if (path === "/v1/billing/portal" && req.method === "POST") return portal(env, user);
  return fail(405, "method not allowed");
}

async function me(env: Env, user: User): Promise<Response> {
  const ent = await entitlement(env, user);
  const usage = await env.VAULT.get(env.VAULT.idFromName(user.id)).usage();
  return json({ email: user.email, vault: user.id, ...ent, usedBytes: usage.total });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const account = await accountRoutes(req, env, url.pathname);
    if (account) return account;

    const m = /^\/v1\/vaults\/([^/]+)\/(push|pull|keys|links\/([0-9a-f]{64})(\/status)?|blobs\/missing|blobs\/([^/]+))$/.exec(url.pathname);
    if (!m) return fail(404, "not found");
    const [, vault, op, linkId, linkStatus, blobId] = m;
    if (!VAULT_RE.test(vault)) return fail(400, "bad vault id");
    const caller = await vaultCaller(req, env, vault);
    if (caller instanceof Response) return caller;
    const stub = env.VAULT.get(env.VAULT.idFromName(vault));

    if (op === "blobs/missing") {
      if (req.method !== "POST") return fail(405, "method not allowed");
      const body = await req.json<{ ids?: unknown }>().catch(() => ({ ids: undefined }));
      const ids = body.ids;
      if (!Array.isArray(ids) || ids.length > MAX_MISSING || !ids.every((id) => typeof id === "string" && BLOB_RE.test(id)))
        return fail(400, "bad ids");
      const heads = await Promise.all(ids.map((id) => env.BLOBS.head(`${vault}/${id}`)));
      return json({ missing: ids.filter((_, i) => !heads[i]) });
    }
    if (blobId !== undefined) {
      if (!BLOB_RE.test(blobId)) return fail(400, "bad blob id");
      const key = `${vault}/${blobId}`;
      if (req.method === "GET") {
        const obj = await env.BLOBS.get(key);
        if (!obj) return fail(404, "no such blob");
        return new Response(obj.body, {
          headers: { "content-type": "application/octet-stream", "content-length": String(obj.size) },
        });
      }
      if (req.method === "PUT") {
        if (!caller.canWrite) return fail(402, NO_PLAN);
        const size = Number(req.headers.get("content-length") ?? "-1");
        if (!Number.isSafeInteger(size) || size < 0) return fail(411, "content-length required");
        if (size > MAX_BLOB) return fail(413, "blob too large");
        if (!(await stub.reserveBlob(blobId, size, caller.limitBytes))) return fail(413, "storage full");
        await env.BLOBS.put(key, req.body ?? new Uint8Array(0));
        return new Response(null, { status: 204 });
      }
      return fail(405, "method not allowed");
    }

    if (linkId !== undefined) {
      if (linkStatus) {
        if (req.method !== "GET") return fail(405, "method not allowed");
        return json({ pending: await stub.linkPending(linkId) });
      }
      if (req.method === "GET") {
        const sealed = await stub.takeLink(linkId);
        return sealed ? json({ sealed }) : fail(404, "no such link (used, cancelled or expired)");
      }
      if (req.method === "DELETE") {
        await stub.cancelLink(linkId);
        return new Response(null, { status: 204 });
      }
      if (req.method !== "PUT") return fail(405, "method not allowed");
      const body = await req.json<{ sealed?: unknown }>().catch(() => ({}) as { sealed?: unknown });
      if (typeof body.sealed !== "string" || body.sealed.length === 0 || body.sealed.length > MAX_ENVELOPE)
        return fail(400, "bad sealed key");
      const res = await stub.putLink(linkId, body.sealed);
      return res.ok ? json({ expires: res.expires }) : fail(429, "too many open device links");
    }

    if (op === "keys") {
      if (req.method === "GET") return json(await stub.getKeys());
      if (req.method !== "PUT") return fail(405, "method not allowed");
      const body = await req.json<{ envelope?: unknown; expectVersion?: unknown }>().catch(() => ({}) as Record<string, unknown>);
      const { envelope, expectVersion } = body as { envelope?: unknown; expectVersion?: unknown };
      if (typeof envelope !== "string" || envelope.length === 0 || envelope.length > MAX_ENVELOPE)
        return fail(400, "bad envelope");
      if (!Number.isSafeInteger(expectVersion) || (expectVersion as number) < 0) return fail(400, "bad expectVersion");
      const res = await stub.putKeys(envelope, expectVersion as number);
      return res.ok ? json({ version: res.version }) : json({ error: "envelope changed", version: res.version }, 409);
    }

    if (op === "pull") {
      if (req.method !== "GET") return fail(405, "method not allowed");
      const since = Number(url.searchParams.get("since") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? String(MAX_PULL));
      if (!Number.isSafeInteger(since) || since < 0) return fail(400, "bad since");
      if (!Number.isSafeInteger(limit) || limit < 1) return fail(400, "bad limit");
      return json(await stub.pull(since, Math.min(limit, MAX_PULL)));
    }

    if (req.method !== "POST") return fail(405, "method not allowed");
    if (!caller.canWrite) return fail(402, NO_PLAN);
    let body: { device?: unknown; changes?: unknown };
    try {
      body = await req.json();
    } catch {
      return fail(400, "bad json");
    }
    if (typeof body.device !== "string" || !UUID_RE.test(body.device)) return fail(400, "bad device");
    if (!validChanges(body.changes)) return fail(400, "bad changes");
    const res = await stub.push(body.device, body.changes, caller.limitBytes);
    return res.full ? fail(413, "storage full") : json(res);
  },
} satisfies ExportedHandler<Env>;
