import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256 } from "../src/auth";
import { MAX_SHARES } from "../src/shares";

const call = (path: string, init?: RequestInit & { session?: string }) =>
  exports.default.fetch(`https://sync.test${path}`, {
    ...init,
    headers: {
      ...(init?.session ? { authorization: `Bearer ${init.session}` } : {}),
      ...(typeof init?.body === "string" && !init.body.startsWith("token=") ? { "content-type": "application/json" } : {}),
      ...((init?.headers as Record<string, string>) ?? {}),
    },
  });

/** A signed-in account; `plan` adds a paid subscription. */
async function account(email: string, plan?: "sync" | "plus"): Promise<{ session: string; vault: string }> {
  const pendingId = `pending-${crypto.randomUUID()}`;
  const token = `token-${crypto.randomUUID()}`;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO sign_ins (pending_hash, token_hash, email, code, created_at, expires_at) VALUES (?, ?, ?, '1234', ?, ?)"
  )
    .bind(await sha256(pendingId), await sha256(token), email, now, now + 60_000)
    .run();
  await call("/v1/auth/verify", {
    method: "POST",
    body: `token=${encodeURIComponent(token)}`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const res = (await (await call("/v1/auth/poll", { method: "POST", body: JSON.stringify({ pendingId }) })).json()) as {
    session: string;
    vault: string;
  };
  if (plan)
    await env.DB.prepare(
      "INSERT INTO subscriptions (user_id, polar_subscription_id, plan, status, current_period_end, updated_at) VALUES (?, ?, ?, 'active', ?, ?)"
    )
      .bind(res.vault, `sub-${res.vault}`, plan, now + 30 * 86_400_000, now)
      .run();
  return res;
}

const bytes = (s: string) => new TextEncoder().encode(s);
const put = (path: string, session: string, body: string) =>
  call(path, { method: "PUT", session, body: bytes(body), headers: { "content-length": String(bytes(body).length) } });

async function newShare(session: string): Promise<string> {
  const res = await call("/v1/shares", { method: "POST", session });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

describe("shared links", () => {
  it("publishes, serves to anyone, updates and stops", async () => {
    const { session } = await account("owner@example.com", "sync");
    const id = await newShare(session);
    expect(id).toMatch(/^[0-9a-f]{32}$/);

    // Nothing published yet: not found, not gone.
    expect((await call(`/v1/shares/${id}`)).status).toBe(404);

    const missing = await call(`/v1/shares/${id}/blobs/missing`, { method: "POST", session, body: JSON.stringify({ ids: ["f1", "f2"] }) });
    expect(await missing.json()).toEqual({ missing: ["f1", "f2"] });
    expect((await put(`/v1/shares/${id}/blobs/f1`, session, "file one")).status).toBe(200);
    const again = await call(`/v1/shares/${id}/blobs/missing`, { method: "POST", session, body: JSON.stringify({ ids: ["f1", "f2"] }) });
    expect(await again.json()).toEqual({ missing: ["f2"] });

    const v1 = await put(`/v1/shares/${id}/manifest?expect=0`, session, "snapshot one");
    expect(await v1.json()).toEqual({ version: 1 });

    // Anyone, no account.
    const head = (await (await call(`/v1/shares/${id}`)).json()) as { version: number; bytes: number };
    expect(head.version).toBe(1);
    expect(head.bytes).toBe("file one".length + "snapshot one".length);
    const m = await call(`/v1/shares/${id}/manifest`);
    expect(m.headers.get("x-share-version")).toBe("1");
    expect(await m.text()).toBe("snapshot one");
    expect(await (await call(`/v1/shares/${id}/blobs/f1`)).text()).toBe("file one");

    // A stale update is refused; a current one replaces the snapshot.
    expect((await put(`/v1/shares/${id}/manifest?expect=0`, session, "stale")).status).toBe(409);
    expect(await (await put(`/v1/shares/${id}/manifest?expect=1`, session, "snapshot two")).json()).toEqual({ version: 2 });
    expect(await (await call(`/v1/shares/${id}/manifest`)).text()).toBe("snapshot two");
    const objects = await env.BLOBS.list({ prefix: `_shares/${id}/manifest/` });
    expect(objects.objects).toHaveLength(1);

    const list = (await (await call("/v1/shares", { session })).json()) as { shares: { id: string; views: number }[] };
    expect(list.shares.map((s) => s.id)).toEqual([id]);
    expect(list.shares[0].views).toBe(2);

    expect((await call(`/v1/shares/${id}`, { method: "DELETE", session })).status).toBe(204);
    expect((await call(`/v1/shares/${id}/manifest`)).status).toBe(404);
    expect((await env.BLOBS.list({ prefix: `_shares/${id}/` })).objects).toHaveLength(0);
  });

  it("needs a paid plan to create or upload, and keeps owners apart", async () => {
    const trial = await account("trial@example.com");
    expect((await call("/v1/shares", { method: "POST", session: trial.session })).status).toBe(402);
    expect((await call("/v1/shares", { method: "POST" })).status).toBe(401);

    const owner = await account("a@example.com", "plus");
    const other = await account("b@example.com", "plus");
    const id = await newShare(owner.session);
    expect((await put(`/v1/shares/${id}/manifest?expect=0`, other.session, "mine now")).status).toBe(404);
    expect((await call(`/v1/shares/${id}`, { method: "DELETE", session: other.session })).status).toBe(404);
    expect((await call(`/v1/shares/${"0".repeat(32)}`)).status).toBe(404);
    expect((await call("/v1/shares/not-an-id")).status).toBe(404);
  });

  it("answers 410 once a link expires or is taken down", async () => {
    const { session } = await account("expiry@example.com", "sync");
    const id = await newShare(session);
    await put(`/v1/shares/${id}/manifest?expect=0`, session, "snap");
    const soon = Date.now() + 60_000;
    expect((await call(`/v1/shares/${id}`, { method: "PATCH", session, body: JSON.stringify({ expiresAt: soon }) })).status).toBe(200);
    expect((await call(`/v1/shares/${id}`, { method: "PATCH", session, body: JSON.stringify({ expiresAt: 5 }) })).status).toBe(400);
    expect((await call(`/v1/shares/${id}`)).status).toBe(200);

    await env.DB.prepare("UPDATE shares SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, id).run();
    expect((await call(`/v1/shares/${id}/manifest`)).status).toBe(410);
    await env.DB.prepare("UPDATE shares SET expires_at = NULL, disabled_at = ? WHERE id = ?").bind(Date.now(), id).run();
    expect((await call(`/v1/shares/${id}`)).status).toBe(410);
    expect((await put(`/v1/shares/${id}/manifest?expect=1`, session, "back")).status).toBe(410);
  });

  it("sweeps files the new version no longer uses", async () => {
    const { session } = await account("sweep@example.com", "sync");
    const id = await newShare(session);
    await put(`/v1/shares/${id}/blobs/old`, session, "old file");
    await put(`/v1/shares/${id}/blobs/kept`, session, "kept file");
    await env.DB.prepare("UPDATE share_blobs SET created_at = 0 WHERE share_id = ?").bind(id).run();
    await put(`/v1/shares/${id}/blobs/fresh`, session, "just uploaded");
    const res = await call(`/v1/shares/${id}/sweep`, { method: "POST", session, body: JSON.stringify({ live: ["kept"] }) });
    expect(await res.json()).toEqual({ removed: 1 });
    expect(await env.BLOBS.head(`_shares/${id}/b/old`)).toBeNull();
    expect(await env.BLOBS.head(`_shares/${id}/b/kept`)).not.toBeNull();
    expect(await env.BLOBS.head(`_shares/${id}/b/fresh`)).not.toBeNull();
  });

  it("counts shares against the owner's storage and caps how many", async () => {
    const { session, vault } = await account("quota@example.com", "sync");
    const id = await newShare(session);
    await put(`/v1/shares/${id}/blobs/f`, session, "12345");
    const me = (await (await call("/v1/me", { session })).json()) as { usedBytes: number; sharedBytes: number };
    expect(me.sharedBytes).toBe(5);
    expect(me.usedBytes).toBeGreaterThanOrEqual(5);

    // Full storage: a share file is refused.
    await env.DB.prepare("UPDATE subscriptions SET plan = 'sync' WHERE user_id = ?").bind(vault).run();
    await env.DB.prepare("INSERT INTO share_blobs (share_id, id, size, created_at) VALUES (?, 'huge', ?, 0)")
      .bind(id, 10 * 1024 ** 3)
      .run();
    expect((await put(`/v1/shares/${id}/blobs/g`, session, "more")).status).toBe(413);

    for (let i = 1; i < MAX_SHARES; i++)
      await env.DB.prepare("INSERT INTO shares (id, owner_id, created_at, updated_at) VALUES (?, ?, 0, 0)")
        .bind(i.toString(16).padStart(32, "f"), vault)
        .run();
    expect((await call("/v1/shares", { method: "POST", session })).status).toBe(429);
  });
});
