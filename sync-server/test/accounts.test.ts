import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256 } from "../src/auth";
import { verifyWebhook } from "../src/billing";

const DEV = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const call = (path: string, init?: RequestInit & { session?: string }) =>
  exports.default.fetch(`https://sync.test${path}`, {
    ...init,
    headers: {
      ...(init?.session ? { authorization: `Bearer ${init.session}` } : {}),
      ...(init?.body && typeof init.body === "string" && !String(init.body).startsWith("token=")
        ? { "content-type": "application/json" }
        : {}),
      ...((init?.headers as Record<string, string>) ?? {}),
    },
  });
const hlc = (ms: number) => `${String(ms).padStart(13, "0")}:0000:${DEV}`;

/** The emailed link's token is never stored, so tests plant a known one. */
async function pendingSignIn(email: string) {
  const pendingId = `pending-${crypto.randomUUID()}`;
  const token = `token-${crypto.randomUUID()}`;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO sign_ins (pending_hash, token_hash, email, code, created_at, expires_at) VALUES (?, ?, ?, '1234', ?, ?)"
  )
    .bind(await sha256(pendingId), await sha256(token), email, now, now + 60_000)
    .run();
  return { pendingId, token };
}

async function signIn(email: string): Promise<{ session: string; vault: string }> {
  const { pendingId, token } = await pendingSignIn(email);
  await call("/v1/auth/verify", { method: "POST", body: `token=${encodeURIComponent(token)}`, headers: { "content-type": "application/x-www-form-urlencoded" } });
  const res = (await (await call("/v1/auth/poll", { method: "POST", body: JSON.stringify({ pendingId }) })).json()) as {
    session: string;
    vault: string;
  };
  return res;
}

describe("email sign-in", () => {
  it("starts with a code, and refuses junk and floods", async () => {
    const res = await call("/v1/auth/start", { method: "POST", body: JSON.stringify({ email: "Flood@Example.com" }) });
    const body = (await res.json()) as { pendingId: string; code: string };
    expect(res.status).toBe(200);
    expect(body.code).toMatch(/^\d{4}$/);
    expect(body.pendingId.length).toBeGreaterThan(30);
    for (let i = 0; i < 4; i++) await call("/v1/auth/start", { method: "POST", body: JSON.stringify({ email: "flood@example.com" }) });
    const sixth = await call("/v1/auth/start", { method: "POST", body: JSON.stringify({ email: "flood@example.com" }) });
    expect(sixth.status).toBe(429);
    expect((await call("/v1/auth/start", { method: "POST", body: JSON.stringify({ email: "nope" }) })).status).toBe(400);
  });

  it("only signs in after the confirm button, and hands the session over once", async () => {
    const { pendingId, token } = await pendingSignIn("ana@example.com");
    const poll = async () =>
      (await (await call("/v1/auth/poll", { method: "POST", body: JSON.stringify({ pendingId }) })).json()) as Record<string, string>;

    // Opening the link (as an email scanner would) shows a page but approves nothing.
    const pageRes = await call(`/v1/auth/verify?token=${encodeURIComponent(token)}`);
    const html = await pageRes.text();
    expect(html).toContain("ana@example.com");
    expect(html).toContain("1234");
    expect((await poll()).status).toBe("pending");

    await call("/v1/auth/verify", {
      method: "POST",
      body: `token=${encodeURIComponent(token)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const ok = await poll();
    expect(ok.status).toBe("ok");
    expect(ok.email).toBe("ana@example.com");
    expect(ok.vault).toMatch(/^[0-9a-f-]{36}$/);
    expect((await poll()).status).toBe("expired"); // once only

    // The same email signs into the same account (and vault) next time.
    const again = await signIn("ana@example.com");
    expect(again.vault).toBe(ok.vault);
    expect(again.session).not.toBe(ok.session);
  });

  it("signs a device out", async () => {
    const { session } = await signIn("out@example.com");
    expect((await call("/v1/me", { session })).status).toBe(200);
    expect((await call("/v1/auth/session", { method: "DELETE", session })).status).toBe(204);
    expect((await call("/v1/me", { session })).status).toBe(401);
  });
});

describe("plans and vault access", () => {
  it("starts on a 14-day trial with 10 GB", async () => {
    const { session } = await signIn("trial@example.com");
    const me = (await (await call("/v1/me", { session })).json()) as Record<string, unknown>;
    expect(me).toMatchObject({ plan: "trial", canSync: true, limitBytes: 10 * 1024 ** 3, usedBytes: 0 });
    const days = ((me.trialEndsAt as number) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);
  });

  it("lets a user into their own vault only", async () => {
    const a = await signIn("a@example.com");
    const b = await signIn("b@example.com");
    const push = (vault: string, session: string) =>
      call(`/v1/vaults/${vault}/push`, {
        method: "POST",
        session,
        body: JSON.stringify({ device: DEV, changes: [{ key: "k", hlc: hlc(1), payload: "e1.x" }] }),
      });
    expect((await push(a.vault, a.session)).status).toBe(200);
    expect((await push(a.vault, b.session)).status).toBe(403);
    expect((await call(`/v1/vaults/${a.vault}/pull`)).status).toBe(401);
    const me = (await (await call("/v1/me", { session: a.session })).json()) as { usedBytes: number };
    expect(me.usedBytes).toBe(4 + 1 + 100); // payload, key and overhead
  });

  it("goes read-only when the trial ends", async () => {
    const { session, vault } = await signIn("lapsed@example.com");
    await env.DB.prepare("UPDATE users SET trial_ends_at = ? WHERE id = ?").bind(Date.now() - 1, vault).run();
    const me = (await (await call("/v1/me", { session })).json()) as Record<string, unknown>;
    expect(me).toMatchObject({ plan: "none", canSync: false });
    const push = await call(`/v1/vaults/${vault}/push`, {
      method: "POST",
      session,
      body: JSON.stringify({ device: DEV, changes: [{ key: "k", hlc: hlc(1), payload: "e1.x" }] }),
    });
    expect(push.status).toBe(402);
    const put = await call(`/v1/vaults/${vault}/blobs/f1`, { method: "PUT", session, body: "abc", headers: { "content-length": "3" } });
    expect(put.status).toBe(402);
    expect((await call(`/v1/vaults/${vault}/pull`, { session })).status).toBe(200); // can still download
  });
});

describe("storage limits", () => {
  /** A record's counted size: payload, key and a fixed overhead. */
  const rec = (key: string, payload: string) => payload.length + key.length + 100;

  it("refuses records and files past the limit; shrinking always works", async () => {
    const vault = env.VAULT.get(env.VAULT.idFromName("quota-1"));
    const change = (key: string, payload: string, ms: number) => ({ key, hlc: hlc(ms), payload });
    const limit = rec("a", "x".repeat(60)) + 50;
    const first = await vault.push(DEV, [change("a", "x".repeat(60), 1)], limit);
    expect(first.accepted).toBe(1);
    expect(first.usedBytes).toBe(rec("a", "x".repeat(60)));
    expect((await vault.push(DEV, [change("b", "x".repeat(60), 2)], limit)).full).toBe(true);
    // Shrinking a record always works.
    expect((await vault.push(DEV, [change("a", "x", 3)], 10)).accepted).toBe(1);
    const used = rec("a", "x");
    expect((await vault.reserveBlob("quota-1", "f1", 50, used + 100)).ok).toBe(true);
    expect((await vault.reserveBlob("quota-1", "f2", 51, used + 100)).ok).toBe(false);
    expect(await vault.usage()).toEqual({ records: used, blobs: 50, total: used + 50 });
  });

  it("counts empty records, so a flood of them isn't free", async () => {
    const vault = env.VAULT.get(env.VAULT.idFromName("quota-empty"));
    const many = Array.from({ length: 50 }, (_, i) => ({ key: `k${i}`, hlc: hlc(i + 1), payload: "" }));
    expect((await vault.push(DEV, many, 1000)).full).toBe(true);
    expect((await vault.usage()).total).toBe(0);
  });

  it("counts an upload from the moment it's let in, and what R2 stored once it lands", async () => {
    const vault = env.VAULT.get(env.VAULT.idFromName("quota-commit"));
    const a = await vault.reserveBlob("quota-commit", "f", 30, 1000);
    // Parallel uploads can't share the same free space.
    expect((await vault.usage()).blobs).toBe(30);
    expect((await vault.reserveBlob("quota-commit", "g", 980, 1000)).ok).toBe(false);
    expect(await vault.commitBlob(a.token, "f", 31, 1000)).toBe(31);
    // A failed upload gives its reservation back; the counted copy stays.
    const b = await vault.reserveBlob("quota-commit", "f", 500, 1000);
    expect((await vault.usage()).blobs).toBe(531);
    await vault.abortBlob(b.token);
    expect((await vault.usage()).blobs).toBe(31);
  });

  it("can't be fooled by overlapping uploads of one file", async () => {
    const vault = env.VAULT.get(env.VAULT.idFromName("quota-race"));
    // A big upload, and a small one of the same id that fails while the big one is in flight.
    const big = await vault.reserveBlob("quota-race", "f", 800, 1000);
    const small = await vault.reserveBlob("quota-race", "f", 1, 1000);
    await vault.abortBlob(small.token);
    expect((await vault.usage()).blobs).toBe(800);
    await vault.commitBlob(big.token, "f", 800, 2000);
    expect((await vault.usage()).blobs).toBe(800);
    // Two that both land: the copy R2 stored last is the one counted, whatever order the bookkeeping arrives in.
    const x = await vault.reserveBlob("quota-race", "g", 100, 10_000);
    const y = await vault.reserveBlob("quota-race", "g", 5, 10_000);
    await vault.commitBlob(x.token, "g", 100, 3002);
    await vault.commitBlob(y.token, "g", 5, 3001);
    expect((await vault.sizes(["g"], [])).blobs).toEqual({ g: 100 });
  });

  it("settles uploads cut off before their bookkeeping, counting what R2 holds", async () => {
    const vault = env.VAULT.get(env.VAULT.idFromName("quota-stale"));
    const lost = await vault.reserveBlob("quota-stale", "landed", 40, 10_000);
    await vault.reserveBlob("quota-stale", "never", 60, 10_000);
    expect(lost.ok).toBe(true);
    await env.BLOBS.put("quota-stale/landed", "x".repeat(40));
    // Hours later the next upload settles both: the stored one counts, the other is let go.
    await vault.reserveBlob("quota-stale", "next", 1, 10_000, Date.now() + 3 * 60 * 60 * 1000);
    expect(await vault.sizes(["landed", "never"], [])).toEqual({ blobs: { landed: 40 }, keys: {} });
    expect((await vault.usage()).blobs).toBe(41);
  });

  it("sweeps files the library no longer uses, safely", async () => {
    const vault = env.VAULT.get(env.VAULT.idFromName("quota-sweep"));
    const change = (key: string, ms: number) => ({ key, hlc: hlc(ms), payload: "p" });
    await vault.push(DEV, [change("r1", 1)], 10_000);
    for (const id of ["used", "unused", "fresh"]) {
      const r = await vault.reserveBlob("quota-sweep", id, 100, 10_000);
      await vault.commitBlob(r.token, id, 100, 1);
      await env.BLOBS.put(`quota-sweep/${id}`, "x");
    }
    const { cursor, epoch } = await vault.pull(0, 500);
    const later = Date.now() + 3 * 60 * 1000; // past the grace period by then
    // A list from a device that hasn't seen the latest change doesn't count.
    expect((await vault.sweep("quota-sweep", cursor - 1, ["used"], later)).ok).toBe(false);
    const res = await vault.sweep("quota-sweep", cursor, ["used"], Date.now() + 60 * 1000);
    // Too new to go yet: the device is told when to ask again.
    expect(res.ok && res.removed).toBe(0);
    expect(res.ok && res.waiting).toBe(2);
    expect(res.ok && res.retryInMs).toBeGreaterThan(30 * 1000);
    expect(res.ok && res.retryInMs).toBeLessThanOrEqual(60 * 1000);
    // A file being uploaded is never swept.
    const moving = await vault.reserveBlob("quota-sweep", "unused", 100, 10_000);
    const swept = await vault.sweep("quota-sweep", cursor, ["used"], later);
    expect(swept.ok && [swept.removed, swept.freed]).toEqual([1, 100]);
    expect(await env.BLOBS.head("quota-sweep/fresh")).toBeNull();
    expect(await env.BLOBS.head("quota-sweep/used")).not.toBeNull();
    await vault.abortBlob(moving.token);
    // Devices learn a sweep deleted something, and re-check their files.
    expect((await vault.pull(cursor, 500)).epoch).toBe(epoch + 1);
    const sizes = await vault.sizes(["used", "fresh"], ["r1", "nope"]);
    expect(sizes).toEqual({ blobs: { used: 100 }, keys: { r1: rec("r1", "p") } });
  });

  it("deletes swept files from storage over HTTP, and refuses junk", async () => {
    const auth = { authorization: "Bearer test-token" };
    const put = (id: string) =>
      call(`/v1/vaults/sweep-http/blobs/${id}`, { method: "PUT", headers: { ...auth, "content-length": "3" }, body: "abc" });
    const first = await put("keepme");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ usedBytes: 3 });
    expect(await (await put("dropme")).json()).toEqual({ usedBytes: 6 });
    const pulled = (await (await call("/v1/vaults/sweep-http/pull?since=0", { headers: auth })).json()) as {
      cursor: number;
      usedBytes: number;
    };
    expect(pulled.usedBytes).toBe(6);
    const sweep = (body: unknown) =>
      call("/v1/vaults/sweep-http/blobs/sweep", { method: "POST", headers: auth, body: JSON.stringify(body) });
    expect((await sweep({ cursor: pulled.cursor, live: "x" })).status).toBe(400);
    expect((await sweep({ cursor: pulled.cursor + 5, live: [] })).status).toBe(409);
    // Fresh files survive a sweep (grace period).
    const res = (await (await sweep({ cursor: pulled.cursor, live: ["keepme"] })).json()) as Record<string, number>;
    expect(res).toMatchObject({ removed: 0, waiting: 1, usedBytes: 6 });
    expect(await env.BLOBS.head("sweep-http/dropme")).not.toBeNull();
    const sizes = await call("/v1/vaults/sweep-http/sizes", { method: "POST", headers: auth, body: JSON.stringify({ blobs: ["keepme"], keys: [] }) });
    expect(await sizes.json()).toEqual({ blobs: { keepme: 3 }, keys: {} });
  });

  it("stores only the bytes it counted, and counts any stored file it serves", async () => {
    const auth = { authorization: "Bearer test-token" };
    const url = "/v1/vaults/len-http/blobs";
    // A body longer than its content-length isn't stored.
    const liar = await call(`${url}/liar`, {
      method: "PUT",
      headers: { ...auth, "content-length": "3" },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("x".repeat(5000)));
          c.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect(liar.status).not.toBe(200);
    expect(await env.BLOBS.head("len-http/liar")).toBeNull();
    // A file in R2 the vault doesn't count (lost bookkeeping) starts counting when it's fetched or checked.
    await env.BLOBS.put("len-http/orphan", "y".repeat(25));
    expect((await call(`${url}/orphan`, { headers: auth })).status).toBe(200);
    const vault = env.VAULT.get(env.VAULT.idFromName("len-http"));
    expect((await vault.usage()).blobs).toBe(25);
    await env.BLOBS.put("len-http/orphan2", "z".repeat(7));
    await call(`${url}/missing`, { method: "POST", headers: auth, body: JSON.stringify({ ids: ["orphan2"] }) });
    expect((await vault.usage()).blobs).toBe(32);
  });
});

describe("abuse limits", () => {
  it("caps uploads per day, and records whatever the plan", async () => {
    const vault = env.VAULT.get(env.VAULT.idFromName("abuse-day"));
    const day = `uploads:${new Date().toISOString().slice(0, 10)}`;
    await runInDurableObject(vault, (_obj, state) => {
      state.storage.sql.exec("INSERT INTO usage (k, v) VALUES (?, 20000)", day);
    });
    expect(await vault.reserveBlob("abuse-day", "f", 1, 1000)).toMatchObject({ ok: false, busy: true });
    const res = await call("/v1/vaults/abuse-day/blobs/f", {
      method: "PUT",
      headers: { authorization: "Bearer test-token", "content-length": "1" },
      body: "x",
    });
    expect(res.status).toBe(429);
    // Tomorrow it starts again.
    const tomorrow = Date.now() + 24 * 60 * 60 * 1000;
    expect((await vault.reserveBlob("abuse-day", "f", 1, 1000, tomorrow)).ok).toBe(true);
    // Records stop at 2 GB even on a plan that allows more.
    await runInDurableObject(vault, (_obj, state) => {
      state.storage.sql.exec("UPDATE usage SET v = ? WHERE k = 'records'", 2 * 1024 ** 3 - 10);
    });
    const big = await vault.push(DEV, [{ key: "k", hlc: hlc(1), payload: "x".repeat(50) }], 100 * 1024 ** 3);
    expect(big.full).toBe(true);
  });

  it("refuses a push too big to handle in one go", async () => {
    const changes = Array.from({ length: 15 }, (_, i) => ({ key: `k${i}`, hlc: hlc(i + 1), payload: "x".repeat(1_400_000) }));
    const res = await call("/v1/vaults/abuse-push/push", {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
      body: JSON.stringify({ device: DEV, changes }),
    });
    expect(res.status).toBe(400);
  });

  it("limits requests per account", async () => {
    const { session, vault } = await signIn("flood@example.com");
    const statuses: number[] = [];
    for (let i = 0; i < 610; i++)
      statuses.push((await call(`/v1/vaults/${vault}/pull?since=0`, { session })).status);
    expect(statuses.slice(0, 600).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    // Another account isn't affected.
    const other = await signIn("calm@example.com");
    expect((await call(`/v1/vaults/${other.vault}/pull?since=0`, { session: other.session })).status).toBe(200);
  });

  it("tells browsers not to guess what a file is", async () => {
    const res = await call("/v1/vaults/abuse-push/pull?since=0", { headers: { authorization: "Bearer test-token" } });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("billing", () => {
  async function signed(body: string, id = crypto.randomUUID(), ts = Math.floor(Date.now() / 1000)) {
    const raw = Uint8Array.from(atob("dGVzdC1zZWNyZXQtdGVzdC1zZWNyZXQ="), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`)))));
    return { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": `v1,${sig}` };
  }
  const event = (userId: string, status: string, product: string, modified: string) =>
    JSON.stringify({
      type: "subscription.updated",
      timestamp: modified,
      data: {
        id: "sub_1",
        status,
        product_id: product,
        current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        cancel_at_period_end: false,
        created_at: "2026-10-01T00:00:00Z",
        modified_at: modified,
        metadata: {},
        customer: { external_id: userId },
      },
    });

  it("verifies Standard Webhooks signatures and refuses replays", async () => {
    const body = '{"type":"x"}';
    const h = new Headers(await signed(body));
    expect(await verifyWebhook("whsec_dGVzdC1zZWNyZXQtdGVzdC1zZWNyZXQ=", h, body)).toBe(true);
    expect(await verifyWebhook("whsec_dGVzdC1zZWNyZXQtdGVzdC1zZWNyZXQ=", h, body + " ")).toBe(false);
    const old = new Headers(await signed(body, "e", Math.floor(Date.now() / 1000) - 3600));
    expect(await verifyWebhook("whsec_dGVzdC1zZWNyZXQtdGVzdC1zZWNyZXQ=", old, body)).toBe(false);
  });

  it("turns Polar subscription events into the user's plan", async () => {
    const { session, vault } = await signIn("payer@example.com");
    const send = async (body: string, headers?: Record<string, string>) =>
      call("/v1/webhooks/polar", { method: "POST", body, headers: headers ?? (await signed(body)) });

    expect((await send(event(vault, "active", "prod-plus-y", "2026-10-10T00:00:00Z"), { "webhook-id": "x" })).status).toBe(403);
    expect((await send(event(vault, "active", "prod-plus-y", "2026-10-10T00:00:00Z"))).status).toBe(200);
    let me = (await (await call("/v1/me", { session })).json()) as Record<string, unknown>;
    expect(me).toMatchObject({ plan: "plus", canSync: true, limitBytes: 100 * 1024 ** 3 });

    // An older event arriving late doesn't undo a newer one.
    await send(event(vault, "canceled", "prod-plus-y", "2026-10-09T00:00:00Z"));
    me = (await (await call("/v1/me", { session })).json()) as Record<string, unknown>;
    expect(me.plan).toBe("plus");
    // A real cancellation that ended does.
    await env.DB.prepare("UPDATE users SET trial_ends_at = 0 WHERE id = ?").bind(vault).run();
    await send(event(vault, "canceled", "prod-plus-y", "2026-10-11T00:00:00Z"));
    me = (await (await call("/v1/me", { session })).json()) as Record<string, unknown>;
    expect(me).toMatchObject({ plan: "none", canSync: false });
  });

  it("opens Polar checkout and the billing portal for the signed-in user", async () => {
    const { session, vault } = await signIn("buyer@example.com");
    const res = await call("/v1/billing/checkout", { method: "POST", session, body: JSON.stringify({ plan: "sync", interval: "year" }) });
    const { url } = (await res.json()) as { url: string };
    expect(url).toContain("product=prod-sync-y");
    expect(url).toContain(`customer=${vault}`);
    expect(url).toContain("auth=Bearer%20polar_oat_test".replace("%20", " "));
    const bad = await call("/v1/billing/checkout", { method: "POST", session, body: JSON.stringify({ plan: "gold", interval: "year" }) });
    expect(bad.status).toBe(400);
    const portal = (await (await call("/v1/billing/portal", { method: "POST", session })).json()) as { url: string };
    expect(portal.url).toBe(`https://polar.test/portal?customer=${vault}`);
  });
});

describe("production safeguards", () => {
  it("only honours the dev token on a local server", async () => {
    const { isDevToken } = await import("../src/index");
    const req = new Request("https://x", { headers: { authorization: "Bearer test-token" } });
    expect(isDevToken(req, { ...env, PUBLIC_URL: "http://127.0.0.1:8787" } as Env)).toBe(true);
    expect(isDevToken(req, { ...env, PUBLIC_URL: "https://sync.brewlm.com" } as unknown as Env)).toBe(false);
    expect(isDevToken(new Request("https://x"), env as Env)).toBe(false);
  });

  it("limits sign-in emails per network address", async () => {
    const start = (email: string) =>
      call("/v1/auth/start", {
        method: "POST",
        body: JSON.stringify({ email }),
        headers: { "cf-connecting-ip": "203.0.113.7" },
      });
    for (let i = 0; i < 20; i++) expect((await start(`spam${i}@example.com`)).status).toBe(200);
    expect((await start("spam-last@example.com")).status).toBe(429);
  });

  it("expires sessions unused for 90 days", async () => {
    const { session } = await signIn("idle@example.com");
    expect((await call("/v1/me", { session })).status).toBe(200);
    await env.DB.prepare("UPDATE sessions SET last_used_at = ?").bind(Date.now() - 91 * 86_400_000).run();
    expect((await call("/v1/me", { session })).status).toBe(401);
  });
});
