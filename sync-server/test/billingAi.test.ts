import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { cycleOf, reconcile, restOfMonth, type AiAccount } from "../src/ai";
import { AI_CONFIG, AI_MONTHLY, AI_TOPUP_CREDIT, AI_TRIAL } from "../src/aiConfig";
import { sha256 } from "../src/auth";

const call = (path: string, init?: RequestInit & { session?: string }) =>
  exports.default.fetch(`https://sync.test${path}`, {
    ...init,
    headers: {
      ...(init?.session ? { authorization: `Bearer ${init.session}` } : {}),
      ...(typeof init?.body === "string" && !init.body.startsWith("token=") ? { "content-type": "application/json" } : {}),
      ...((init?.headers as Record<string, string>) ?? {}),
    },
  });

async function account(email: string): Promise<{ session: string; id: string }> {
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
  return { session: res.session, id: res.vault };
}

async function signed(body: string, id = crypto.randomUUID()) {
  const ts = Math.floor(Date.now() / 1000);
  const raw = Uint8Array.from(atob("dGVzdC1zZWNyZXQtdGVzdC1zZWNyZXQ="), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`)))));
  return { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": `v1,${sig}` };
}

const send = async (type: string, data: Record<string, unknown>) => {
  const body = JSON.stringify({ type, data });
  return call("/v1/webhooks/polar", { method: "POST", body, headers: await signed(body) });
};

let clock = Date.parse("2026-11-01T00:00:00Z");
/** A Polar subscription event; each one is newer than the last. */
function subscription(userId: string, product: string, status = "active", extra: Record<string, unknown> = {}) {
  clock += 1000;
  return send("subscription.updated", {
    id: `sub-${userId}`,
    status,
    product_id: product,
    current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    cancel_at_period_end: false,
    created_at: "2026-10-01T00:00:00Z",
    modified_at: new Date(clock).toISOString(),
    metadata: {},
    customer: { external_id: userId },
    ...extra,
  });
}

function topupOrder(type: string, userId: string, orderId: string, refunded = 0) {
  return send(type, {
    id: orderId,
    status: refunded ? "partially_refunded" : "paid",
    paid: true,
    product_id: "prod-ai-topup",
    net_amount: 700,
    refunded_amount: refunded,
    metadata: { user_id: userId, kind: "ai_topup" },
    customer: { external_id: userId },
  });
}

const row = (id: string) => env.DB.prepare("SELECT * FROM ai_accounts WHERE user_id = ?").bind(id).first<AiAccount>();
const orLimit = async (hash: string) =>
  ((await (await fetch("https://openrouter.test/api/v1/__keys")).json()) as { hash: string; limit: number }[]).find((k) => k.hash === hash)?.limit;
const setUsage = (hash: string, usage: number) =>
  fetch("https://openrouter.test/api/v1/__usage", { method: "POST", body: JSON.stringify({ hash, usage }) });
const polarCalls = async () => (await (await fetch("https://polar.test/__calls")).json()) as { path: string; body: Record<string, unknown> }[];
const checkout = async (session: string, body: unknown) => {
  const res = await call("/v1/billing/checkout", { method: "POST", session, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as { url?: string; error?: string; change?: boolean } };
};
const change = async (session: string, body: unknown) => {
  const res = await call("/v1/billing/change", { method: "POST", session, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as { when?: string; error?: string } };
};

describe("Pro and Max checkout", () => {
  it("sells Pro and Max, refuses a second subscription, and sells top-ups only to AI plans", async () => {
    const a = await account("checkout-pro@example.com");
    expect((await checkout(a.session, { plan: "topup" })).status).toBe(402);
    const pro = await checkout(a.session, { plan: "pro", interval: "year" });
    expect(pro.body.url).toContain("product=prod-pro-y");

    await subscription(a.id, "prod-pro-y");
    const again = await checkout(a.session, { plan: "max", interval: "month" });
    expect(again.status).toBe(409);
    expect(again.body.change).toBe(true);
    const topup = await checkout(a.session, { plan: "topup" });
    expect(topup.body.url).toContain("product=prod-ai-topup");
  });
});

describe("subscription webhooks and the AI allowance", () => {
  it("grants the allowance as the subscription starts, and revokes the key as it ends", async () => {
    const a = await account("hook-pro@example.com");
    await subscription(a.id, "prod-pro-m", "trialing");
    expect((await row(a.id))?.cap).toBeCloseTo(AI_TRIAL, 4);

    await subscription(a.id, "prod-pro-m", "active");
    expect((await row(a.id))?.cap).toBeCloseTo(AI_TRIAL + (AI_MONTHLY.pro - AI_TRIAL) * restOfMonth(Date.now()), 2);

    await call("/v1/ai/openrouter/embeddings", { method: "POST", session: a.session, body: JSON.stringify({ model: AI_CONFIG.roles.embedding.model, input: "x" }) });
    const hash = (await row(a.id))!.key_hash!;
    expect(await orLimit(hash)).toBeGreaterThan(0);
    await subscription(a.id, "prod-pro-m", "canceled");
    expect(await orLimit(hash)).toBeUndefined(); // deleted on OpenRouter
    expect((await row(a.id))?.monthly).toBe(0);
  });

  it("leaves Sync and Sync Plus without AI", async () => {
    const a = await account("hook-sync@example.com");
    await subscription(a.id, "prod-plus-m");
    expect(await row(a.id)).toBeNull();
  });
});

describe("changing plans", () => {
  it("upgrades now with the prorated charge, and downgrades at renewal", async () => {
    const a = await account("change@example.com");
    expect((await change(a.session, { plan: "pro", interval: "month" })).status).toBe(409);
    await subscription(a.id, "prod-sync-m");

    const up = await change(a.session, { plan: "pro", interval: "month" });
    expect(up).toMatchObject({ status: 200, body: { when: "now" } });
    let last = (await polarCalls()).at(-1)!;
    expect(last.path).toBe(`/v1/subscriptions/sub-${a.id}`);
    expect(last.body).toEqual({ product_id: "prod-pro-m", proration_behavior: "invoice" });

    await subscription(a.id, "prod-max-y");
    const me = (await (await call("/v1/me", { session: a.session })).json()) as { plan: string; interval: string };
    expect(me).toMatchObject({ plan: "max", interval: "year" });
    const down = await change(a.session, { plan: "pro", interval: "year" });
    expect(down.body.when).toBe("renewal");
    expect((await polarCalls()).at(-1)!.body).toEqual({ product_id: "prod-pro-y", proration_behavior: "next_period" });
    // Yearly → monthly on the same plan waits for renewal too.
    expect((await change(a.session, { plan: "max", interval: "month" })).body.when).toBe("renewal");
    expect((await change(a.session, { plan: "max", interval: "year" })).status).toBe(400);
    expect((await change(a.session, { plan: "gold", interval: "year" })).status).toBe(400);
  });

  it("undoes a pending cancellation first, and changes nothing if the charge fails", async () => {
    const a = await account("change-cancel@example.com");
    await subscription(a.id, "prod-sync-m", "active", { cancel_at_period_end: true });
    await change(a.session, { plan: "pro", interval: "month" });
    const calls = (await polarCalls()).slice(-2);
    expect(calls[0].body).toEqual({ cancel_at_period_end: false });
    expect(calls[1].body.product_id).toBe("prod-pro-m");

    const d = await account("change-declined@example.com");
    await subscription(d.id, "prod-sync-m", "active", { id: `sub-declined-${d.id}` });
    const res = await change(d.session, { plan: "max", interval: "month" });
    expect(res.status).toBe(402);
    expect(res.body.error).toMatch(/payment/i);
  });
});

describe("AI top-ups", () => {
  it("adds a paid top-up once, and a refund takes its share back", async () => {
    const a = await account("topup@example.com");
    await subscription(a.id, "prod-pro-m");
    await call("/v1/ai/openrouter/embeddings", { method: "POST", session: a.session, body: JSON.stringify({ model: AI_CONFIG.roles.embedding.model, input: "x" }) });
    const before = (await row(a.id))!;

    expect((await topupOrder("order.paid", a.id, "order-t1")).status).toBe(200);
    await topupOrder("order.updated", a.id, "order-t1"); // the same order again
    let r = (await row(a.id))!;
    expect(r.topup).toBe(AI_TOPUP_CREDIT);
    expect(await orLimit(r.key_hash!)).toBeCloseTo(before.cap + AI_TOPUP_CREDIT, 4);

    await topupOrder("order.refunded", a.id, "order-t1", 350); // half refunded
    r = (await row(a.id))!;
    expect(r.topup).toBeCloseTo(AI_TOPUP_CREDIT / 2, 4);
    expect(await orLimit(r.key_hash!)).toBeCloseTo(r.cap + AI_TOPUP_CREDIT / 2, 4);
  });

  it("never takes back more than is left unspent", async () => {
    const a = await account("topup-spent@example.com");
    await subscription(a.id, "prod-max-m");
    await call("/v1/ai/openrouter/embeddings", { method: "POST", session: a.session, body: JSON.stringify({ model: AI_CONFIG.roles.embedding.model, input: "x" }) });
    await topupOrder("order.paid", a.id, "order-t2");
    const r = (await row(a.id))!;
    await setUsage(r.key_hash!, r.cap + 4); // 1 of the 5 unspent
    await topupOrder("order.refunded", a.id, "order-t2", 700);
    expect((await row(a.id))!.topup).toBeCloseTo(4, 4);
  });

  it("carries unused top-up credit into next month", async () => {
    const a = await account("topup-carry@example.com");
    await subscription(a.id, "prod-pro-m");
    await call("/v1/ai/openrouter/embeddings", { method: "POST", session: a.session, body: JSON.stringify({ model: AI_CONFIG.roles.embedding.model, input: "x" }) });
    await topupOrder("order.paid", a.id, "order-t3");
    const r = (await row(a.id))!;
    await setUsage(r.key_hash!, r.cap + 1); // the allowance and 1 of the top-up spent

    const d = new Date();
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) + 3_600_000;
    const rolled = (await reconcile(env, a.id, next))!;
    expect(rolled.cycle).toBe(cycleOf(next));
    expect(rolled.cap).toBe(AI_MONTHLY.pro);
    expect(rolled.topup).toBeCloseTo(AI_TOPUP_CREDIT - 1, 4);
  });

  it("ignores orders for other products", async () => {
    const a = await account("topup-other@example.com");
    const res = await send("order.paid", { id: "order-x", status: "paid", product_id: "prod-sync-m", net_amount: 500, refunded_amount: 0, customer: { external_id: a.id } });
    expect(((await res.json()) as { ignored?: string }).ignored).toBe("not an AI top-up");
  });
});
