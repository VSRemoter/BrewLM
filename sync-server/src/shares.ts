/**
 * Shared notebook links: a read-only snapshot anyone with the link can open.
 *
 * The app encrypts the snapshot (the "manifest") and each media file with a
 * random key that only the link carries, after the `#`, which browsers never
 * send. So, as with vaults, the server stores bytes it can't read, under
 * names it can't connect to files (the app derives blob ids from the key).
 *
 * Owner routes (signed in, paid plan — not the trial, so a throwaway account
 * can't host files):
 *   POST   /v1/shares                     → { id }
 *   GET    /v1/shares                     → { shares: [...] }
 *   PATCH  /v1/shares/:id                 { expiresAt: ms | null }
 *   DELETE /v1/shares/:id                 the link stops working at once
 *   POST   /v1/shares/:id/blobs/missing   { ids } → { missing }
 *   PUT    /v1/shares/:id/blobs/:blob     (raw bytes)
 *   PUT    /v1/shares/:id/manifest?expect=<version>  (raw bytes) → { version }  (409 if stale)
 *   POST   /v1/shares/:id/sweep           { live } → { removed }  (files the new version doesn't use)
 *
 * Public routes (no account):
 *   GET  /v1/shares/:id                   → { version, bytes, updatedAt, expiresAt }
 *   GET  /v1/shares/:id/manifest          the current snapshot; `x-share-version` says which
 *   GET  /v1/shares/:id/blobs/:blob
 *   POST /v1/shares/:id/report            { reason } (emails the admin; a few a day per address)
 * A link that was stopped, taken down or has expired answers 410, and so
 * does one whose owner's plan ended over LAPSED_GRACE_MS ago (it comes back
 * if they subscribe again).
 *
 * Admin (ADMIN_TOKEN):
 *   POST /v1/admin/shares/:id             { disabled: boolean }  take a link down / bring it back
 *
 * `sweepShares` (hourly cron) deletes expired links and abandoned ones that
 * were never published, freeing their owners' storage, and old reports.
 *
 * Storage: a share's bytes count against its owner's plan, together with the
 * vault (index.ts lowers the vault's limit by them). Each manifest version is
 * its own R2 object, so a reader never sees half of an update: the new one is
 * stored first, then the version (and object name) moves, then the old one goes.
 */
import { userForSession, type User } from "./auth";
import { entitlement } from "./billing";
import { sendReportEmail } from "./email";

const SHARE_RE = /^[0-9a-f]{32}$/;
const BLOB_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Workers accept request bodies up to 100 MB. */
export const MAX_SHARE_FILE = 100 * 1024 * 1024;
/** One shared notebook, all versions' files together. */
export const MAX_SHARE_BYTES = 2 * 1024 ** 3;
export const MAX_SHARES = 50;
const MAX_IDS = 1000;
/** The longest a link can be set to last. */
const MAX_EXPIRY_MS = 366 * 24 * 60 * 60 * 1000;
/** A file this young survives a sweep: another device of the owner may be publishing. */
export const SHARE_SWEEP_GRACE_MS = 2 * 60 * 1000;
/** A link's owner without a plan for this long: the link pauses until they subscribe again. */
export const LAPSED_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_REPORTS_PER_DAY = 5;
const MAX_REASON = 2000;
/** A link created but never published is dropped after this. */
const ABANDONED_MS = 24 * 60 * 60 * 1000;
const REPORTS_KEPT_MS = 180 * 24 * 60 * 60 * 1000;
/** Links deleted per sweep run: each costs a few storage calls. */
const SWEEP_BATCH = 25;

const PREFIX = (id: string) => `_shares/${id}/`;
/** Each upload gets its own object, so two devices publishing at once can't overwrite each other's. */
const newManifestKey = (id: string, version: number) => `${PREFIX(id)}manifest/${version}-${crypto.randomUUID()}`;
const blobKey = (id: string, blob: string) => `${PREFIX(id)}b/${blob}`;

interface ShareRow {
  id: string;
  owner_id: string;
  version: number;
  manifest_key: string;
  manifest_bytes: number;
  views: number;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  disabled_at: number | null;
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra },
  });
}
const fail = (status: number, error: string) => json({ error }, status);
const SLOW_DOWN = "Too many requests. Wait a minute and try again.";
const GONE = "This shared notebook is no longer available.";

async function flooding(env: Env, key: string): Promise<boolean> {
  return !(await env.ACCOUNT_RATE.limit({ key })).success;
}

/** Bytes all of an owner's shares hold. */
export async function sharedBytes(env: Env, ownerId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT coalesce((SELECT sum(manifest_bytes) FROM shares WHERE owner_id = ?1), 0)
          + coalesce((SELECT sum(b.size) FROM share_blobs b JOIN shares s ON s.id = b.share_id WHERE s.owner_id = ?1), 0) AS n`
  )
    .bind(ownerId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function shareBytes(env: Env, id: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT manifest_bytes + coalesce((SELECT sum(size) FROM share_blobs WHERE share_id = ?1), 0) AS n FROM shares WHERE id = ?1"
  )
    .bind(id)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

const getShare = (env: Env, id: string) => env.DB.prepare("SELECT * FROM shares WHERE id = ?").bind(id).first<ShareRow>();

const live = (s: ShareRow, now = Date.now()) => s.disabled_at === null && (s.expires_at === null || s.expires_at > now);

/** Room for `size` more bytes under the owner's plan, counting the vault too? */
async function fits(env: Env, user: User, limitBytes: number, shareId: string, size: number): Promise<boolean> {
  if ((await shareBytes(env, shareId)) + size > MAX_SHARE_BYTES) return false;
  const vault = await env.VAULT.get(env.VAULT.idFromName(user.id)).usage();
  return vault.total + (await sharedBytes(env, user.id)) + size <= limitBytes;
}

/** Remove a share's files and rows. */
async function destroy(env: Env, id: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.BLOBS.list({ prefix: PREFIX(id), cursor });
    if (page.objects.length) await env.BLOBS.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM share_blobs WHERE share_id = ?").bind(id),
    env.DB.prepare("DELETE FROM shares WHERE id = ?").bind(id),
  ]);
}

/** Exactly `size` bytes of the request body into R2, or null if they didn't all arrive. */
async function store(env: Env, req: Request, key: string, size: number): Promise<R2Object | null> {
  try {
    const body = req.body && size > 0 ? req.body.pipeThrough(new FixedLengthStream(size)) : new Uint8Array(0);
    return await env.BLOBS.put(key, body);
  } catch {
    return null;
  }
}

function contentLength(req: Request): number | Response {
  const size = Number(req.headers.get("content-length") ?? "-1");
  if (!Number.isSafeInteger(size) || size < 0) return fail(411, "content-length required");
  if (size > MAX_SHARE_FILE) return fail(413, "file too large");
  return size;
}

export async function shareRoutes(req: Request, env: Env, path: string): Promise<Response | null> {
  if (path === "/v1/shares") return ownerRoutes(req, env, null, null);
  const admin = /^\/v1\/admin\/shares\/([0-9a-f]{32})$/.exec(path);
  if (admin) return adminRoute(req, env, admin[1]);
  const m = /^\/v1\/shares\/([^/]+)(?:\/(manifest|sweep|report|blobs\/missing|blobs\/([^/]+)))?$/.exec(path);
  if (!m) return null;
  const [, id, op, blob] = m;
  if (!SHARE_RE.test(id)) return fail(404, "no such share");
  if (blob !== undefined && !BLOB_RE.test(blob)) return fail(400, "bad blob id");
  if (op === "report") return req.method === "POST" ? report(req, env, id) : fail(405, "method not allowed");
  const publicRead = req.method === "GET" && (op === undefined || op === "manifest" || blob !== undefined);
  return publicRead ? publicRoutes(req, env, id, op, blob) : ownerRoutes(req, env, id, op ?? null, blob);
}

/** Does the owner still have a plan, or lost it under LAPSED_GRACE_MS ago? */
async function ownerActive(env: Env, ownerId: string, now = Date.now()): Promise<boolean> {
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(ownerId).first<User>();
  if (!user) return false;
  if ((await entitlement(env, user)).canSync) return true;
  const sub = await env.DB.prepare("SELECT current_period_end, updated_at FROM subscriptions WHERE user_id = ?")
    .bind(ownerId)
    .first<{ current_period_end: number | null; updated_at: number }>();
  const lapsedAt = sub ? sub.current_period_end ?? sub.updated_at : user.trial_ends_at;
  return lapsedAt + LAPSED_GRACE_MS > now;
}

async function report(req: Request, env: Env, id: string): Promise<Response> {
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  if (await flooding(env, `share-ip:${ip}`)) return fail(429, SLOW_DOWN);
  const body = await req.json<{ reason?: unknown }>().catch(() => ({}) as { reason?: unknown });
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason || reason.length > MAX_REASON) return fail(400, "Say briefly what's wrong with this notebook.");
  const share = await getShare(env, id);
  if (!share) return fail(404, "no such share");
  const now = Date.now();
  const recent = await env.DB.prepare("SELECT count(*) AS n FROM share_reports WHERE ip = ? AND created_at > ?")
    .bind(ip, now - 24 * 60 * 60 * 1000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_REPORTS_PER_DAY) return fail(429, "Too many reports from here today. Try again tomorrow.");
  await env.DB.prepare("INSERT INTO share_reports (share_id, reason, ip, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, reason, ip, now)
    .run();
  const count = await env.DB.prepare("SELECT count(*) AS n FROM share_reports WHERE share_id = ?").bind(id).first<{ n: number }>();
  try {
    await sendReportEmail(env, id, reason, count?.n ?? 1);
  } catch (e) {
    console.error("share report email failed", e); // the report is stored either way
  }
  return json({ ok: true });
}

async function adminRoute(req: Request, env: Env, id: string): Promise<Response> {
  const token = env.ADMIN_TOKEN;
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const enc = new TextEncoder();
  if (!token || given.length !== token.length || !crypto.subtle.timingSafeEqual(enc.encode(given), enc.encode(token)))
    return fail(401, "unauthorized");
  if (req.method !== "POST") return fail(405, "method not allowed");
  const body = await req.json<{ disabled?: unknown }>().catch(() => ({}) as { disabled?: unknown });
  if (typeof body.disabled !== "boolean") return fail(400, "bad disabled");
  const res = await env.DB.prepare("UPDATE shares SET disabled_at = ? WHERE id = ?")
    .bind(body.disabled ? Date.now() : null, id)
    .run();
  return res.meta.changes === 1 ? json({ disabled: body.disabled }) : fail(404, "no such share");
}

/** Hourly: delete expired and abandoned links (their files too) and old reports. */
export async function sweepShares(env: Env, now = Date.now()): Promise<{ removed: number }> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM shares
     WHERE (expires_at IS NOT NULL AND expires_at < ?1) OR (version = 0 AND created_at < ?2)
     LIMIT ${SWEEP_BATCH}`
  )
    .bind(now, now - ABANDONED_MS)
    .all<{ id: string }>();
  for (const r of results) await destroy(env, r.id);
  await env.DB.prepare("DELETE FROM share_reports WHERE created_at < ?").bind(now - REPORTS_KEPT_MS).run();
  return { removed: results.length };
}

async function publicRoutes(req: Request, env: Env, id: string, op: string | undefined, blob: string | undefined) {
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  if (await flooding(env, `share-ip:${ip}`)) return fail(429, SLOW_DOWN);
  const share = await getShare(env, id);
  if (!share) return fail(404, "no such share");
  if (!live(share) || share.version === 0) return fail(share.version === 0 && live(share) ? 404 : 410, GONE);
  if (!(await ownerActive(env, share.owner_id))) return fail(410, GONE);

  if (op === undefined)
    return json({
      version: share.version,
      bytes: await shareBytes(env, id),
      updatedAt: share.updated_at,
      expiresAt: share.expires_at,
    });

  const key = blob !== undefined ? blobKey(id, blob) : share.manifest_key;
  const obj = await env.BLOBS.get(key);
  if (!obj) return fail(404, blob !== undefined ? "no such file" : "no such version");
  if (blob === undefined) await env.DB.prepare("UPDATE shares SET views = views + 1 WHERE id = ?").bind(id).run();
  return new Response(obj.body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(obj.size),
      "x-content-type-options": "nosniff",
      // Files never change under one id; the manifest does with each update.
      "cache-control": blob !== undefined ? "private, max-age=86400" : "no-store",
      "x-share-version": String(share.version),
    },
  });
}

async function ownerRoutes(req: Request, env: Env, id: string | null, op: string | null, blob?: string) {
  const user = await userForSession(env, req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
  if (!user) return fail(401, "unauthorized");
  if (await flooding(env, user.id)) return fail(429, SLOW_DOWN);

  if (id === null) {
    if (req.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM shares WHERE owner_id = ? ORDER BY created_at DESC")
        .bind(user.id)
        .all<ShareRow>();
      const shares = await Promise.all(
        results.map(async (s) => ({
          id: s.id,
          version: s.version,
          bytes: await shareBytes(env, s.id),
          views: s.views,
          createdAt: s.created_at,
          updatedAt: s.updated_at,
          expiresAt: s.expires_at,
          disabled: s.disabled_at !== null,
        }))
      );
      return json({ shares });
    }
    if (req.method !== "POST") return fail(405, "method not allowed");
    const ent = await entitlement(env, user);
    if (!ent.canSync || ent.plan === "trial") return fail(402, "Sharing links come with a BrewLM Sync plan.");
    const count = await env.DB.prepare("SELECT count(*) AS n FROM shares WHERE owner_id = ?").bind(user.id).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_SHARES) return fail(429, `You can have up to ${MAX_SHARES} shared links. Stop sharing one to make another.`);
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const newId = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    const now = Date.now();
    await env.DB.prepare("INSERT INTO shares (id, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .bind(newId, user.id, now, now)
      .run();
    return json({ id: newId });
  }

  const share = await getShare(env, id);
  // Someone else's link looks the same as no link.
  if (!share || share.owner_id !== user.id) return fail(404, "no such share");

  if (op === null) {
    if (req.method === "DELETE") {
      await destroy(env, id);
      return new Response(null, { status: 204 });
    }
    if (req.method !== "PATCH") return fail(405, "method not allowed");
    const body = await req.json<{ expiresAt?: unknown }>().catch(() => ({}) as { expiresAt?: unknown });
    const exp = body.expiresAt;
    const now = Date.now();
    if (exp !== null && !(Number.isSafeInteger(exp) && (exp as number) > now && (exp as number) <= now + MAX_EXPIRY_MS))
      return fail(400, "bad expiresAt");
    await env.DB.prepare("UPDATE shares SET expires_at = ? WHERE id = ?").bind(exp, id).run();
    return json({ expiresAt: exp });
  }

  // Everything below adds to or tidies a link the owner may still change.
  if (share.disabled_at !== null) return fail(410, "This link was taken down.");
  const ent = await entitlement(env, user);
  const mayWrite = ent.canSync && ent.plan !== "trial";

  if (op === "blobs/missing") {
    if (req.method !== "POST") return fail(405, "method not allowed");
    const body = await req.json<{ ids?: unknown }>().catch(() => ({ ids: undefined }));
    const ids = body.ids;
    if (!Array.isArray(ids) || ids.length > MAX_IDS || !ids.every((x) => typeof x === "string" && BLOB_RE.test(x)))
      return fail(400, "bad ids");
    const have = new Set<string>();
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100) as string[];
      const { results } = await env.DB.prepare(
        `SELECT id FROM share_blobs WHERE share_id = ? AND id IN (${part.map(() => "?").join(",")})`
      )
        .bind(id, ...part)
        .all<{ id: string }>();
      results.forEach((r) => have.add(r.id));
    }
    return json({ missing: (ids as string[]).filter((x) => !have.has(x)) });
  }

  if (op === "sweep") {
    // Allowed without a plan too: it only ever frees space.
    if (req.method !== "POST") return fail(405, "method not allowed");
    const body = await req.json<{ live?: unknown }>().catch(() => ({ live: undefined }));
    const keep = body.live;
    if (!Array.isArray(keep) || keep.length > 200_000 || !keep.every((x) => typeof x === "string" && BLOB_RE.test(x)))
      return fail(400, "bad live list");
    const keepSet = new Set(keep as string[]);
    const { results } = await env.DB.prepare("SELECT id FROM share_blobs WHERE share_id = ? AND created_at < ?")
      .bind(id, Date.now() - SHARE_SWEEP_GRACE_MS)
      .all<{ id: string }>();
    const gone = results.map((r) => r.id).filter((x) => !keepSet.has(x));
    for (let i = 0; i < gone.length; i += 500) {
      const part = gone.slice(i, i + 500);
      await env.BLOBS.delete(part.map((b) => blobKey(id, b)));
      await env.DB.batch(part.map((b) => env.DB.prepare("DELETE FROM share_blobs WHERE share_id = ? AND id = ?").bind(id, b)));
    }
    return json({ removed: gone.length });
  }

  if (req.method !== "PUT") return fail(405, "method not allowed");
  if (!mayWrite) return fail(402, "Sharing links come with a BrewLM Sync plan.");
  const size = contentLength(req);
  if (size instanceof Response) return size;

  if (blob !== undefined) {
    const prior = await env.DB.prepare("SELECT size FROM share_blobs WHERE share_id = ? AND id = ?")
      .bind(id, blob)
      .first<{ size: number }>();
    if (!(await fits(env, user, ent.limitBytes, id, size - (prior?.size ?? 0)))) return fail(413, "storage full");
    const stored = await store(env, req, blobKey(id, blob), size);
    if (!stored) return fail(502, "upload didn't complete");
    await env.DB.prepare(
      "INSERT INTO share_blobs (share_id, id, size, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (share_id, id) DO UPDATE SET size = excluded.size, created_at = excluded.created_at"
    )
      .bind(id, blob, stored.size, Date.now())
      .run();
    return json({ ok: true });
  }

  // op === "manifest"
  const expect = Number(new URL(req.url).searchParams.get("expect") ?? "-1");
  if (!Number.isSafeInteger(expect) || expect < 0) return fail(400, "bad expect");
  if (expect !== share.version) return json({ error: "the link changed", version: share.version }, 409);
  // The old version stays until the new one is in place, so both count meanwhile.
  if (!(await fits(env, user, ent.limitBytes, id, size))) return fail(413, "storage full");
  const next = expect + 1;
  const key = newManifestKey(id, next);
  const stored = await store(env, req, key, size);
  if (!stored) return fail(502, "upload didn't complete");
  const moved = await env.DB.prepare(
    "UPDATE shares SET version = ?, manifest_key = ?, manifest_bytes = ?, updated_at = ? WHERE id = ? AND version = ?"
  )
    .bind(next, key, stored.size, Date.now(), id, expect)
    .run();
  if (moved.meta.changes !== 1) {
    // Another device published first; its version stays.
    await env.BLOBS.delete(key);
    const now = await getShare(env, id);
    return json({ error: "the link changed", version: now?.version ?? 0 }, 409);
  }
  if (share.manifest_key) await env.BLOBS.delete(share.manifest_key);
  return json({ version: next });
}
