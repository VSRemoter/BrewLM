import { env } from "cloudflare:test";
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
    expect(me.usedBytes).toBe(4);
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
  it("refuses records and files past the limit, but never deletes", async () => {
    const vault = env.VAULT.get(env.VAULT.idFromName("quota-1"));
    const change = (key: string, payload: string, ms: number) => ({ key, hlc: hlc(ms), payload });
    expect((await vault.push(DEV, [change("a", "x".repeat(60), 1)], 100)).accepted).toBe(1);
    expect((await vault.push(DEV, [change("b", "x".repeat(60), 2)], 100)).full).toBe(true);
    expect((await vault.usage()).total).toBe(60);
    // Shrinking a record always works.
    expect((await vault.push(DEV, [change("a", "x", 3)], 10)).accepted).toBe(1);
    expect(await vault.reserveBlob("f1", 50, 100)).toBe(true);
    expect(await vault.reserveBlob("f2", 50, 100)).toBe(false);
    expect(await vault.reserveBlob("f1", 40, 100)).toBe(true); // rewrite replaces its old size
    expect(await vault.usage()).toEqual({ records: 1, blobs: 40, total: 41 });
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
