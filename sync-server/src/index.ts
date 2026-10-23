/**
 * BrewLM Sync server (Cloudflare Worker).
 *
 *   POST /v1/vaults/:vault/push   { device, changes: [{ key, hlc, payload }] }
 *   GET  /v1/vaults/:vault/pull?since=<seq>&limit=<n>
 *   POST /v1/vaults/:vault/blobs/missing   { ids } → { missing }
 *   PUT  /v1/vaults/:vault/blobs/:id       (raw bytes)
 *   GET  /v1/vaults/:vault/blobs/:id
 *
 * Blobs are files kept in R2 under "<vault>/<id>": media (audio, images) and
 * records too big for the change log. Like records, they're opaque bytes.
 *
 * Milestone 2a: one shared dev token (SYNC_DEV_TOKEN, from .dev.vars) guards
 * every vault. Accounts, per-user vaults and quotas arrive in milestone 2e.
 * `Env` is generated from wrangler.jsonc by `npm run types`.
 */
import { HLC_RE, MAX_KEY, MAX_PAYLOAD, MAX_PULL, MAX_PUSH, type Change, Vault } from "./vault";

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

async function authorized(req: Request, env: Env): Promise<boolean> {
  const token = env.SYNC_DEV_TOKEN;
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!token || given.length !== token.length) return false;
  const enc = new TextEncoder();
  return crypto.subtle.timingSafeEqual(enc.encode(given), enc.encode(token));
}

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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const m = /^\/v1\/vaults\/([^/]+)\/(push|pull|blobs\/missing|blobs\/([^/]+))$/.exec(url.pathname);
    if (!m) return fail(404, "not found");
    if (!env.SYNC_DEV_TOKEN) return fail(500, "server not configured");
    if (!(await authorized(req, env))) return fail(401, "unauthorized");
    const [, vault, op, blobId] = m;
    if (!VAULT_RE.test(vault)) return fail(400, "bad vault id");

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
        const size = Number(req.headers.get("content-length") ?? "-1");
        if (!Number.isSafeInteger(size) || size < 0) return fail(411, "content-length required");
        if (size > MAX_BLOB) return fail(413, "blob too large");
        await env.BLOBS.put(key, req.body ?? new Uint8Array(0));
        return new Response(null, { status: 204 });
      }
      return fail(405, "method not allowed");
    }

    const stub = env.VAULT.get(env.VAULT.idFromName(vault));

    if (op === "pull") {
      if (req.method !== "GET") return fail(405, "method not allowed");
      const since = Number(url.searchParams.get("since") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? String(MAX_PULL));
      if (!Number.isSafeInteger(since) || since < 0) return fail(400, "bad since");
      if (!Number.isSafeInteger(limit) || limit < 1) return fail(400, "bad limit");
      return json(await stub.pull(since, Math.min(limit, MAX_PULL)));
    }

    if (req.method !== "POST") return fail(405, "method not allowed");
    let body: { device?: unknown; changes?: unknown };
    try {
      body = await req.json();
    } catch {
      return fail(400, "bad json");
    }
    if (typeof body.device !== "string" || !UUID_RE.test(body.device)) return fail(400, "bad device");
    if (!validChanges(body.changes)) return fail(400, "bad changes");
    return json(await stub.push(body.device, body.changes));
  },
} satisfies ExportedHandler<Env>;
