import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { rampAmount, reconcile, type AiAccount } from "../src/ai";
import { AI_CONFIG, AI_MONTHLY, AI_RAMP_DAYS, AI_TOPUP_CREDIT, AI_TOPUP_PRICE, AI_TOPUPS_PER_MONTH } from "../src/aiConfig";
import { limits } from "../src/aiGuard";
import { sha256 } from "../src/auth";
import { DAILY_LIMIT, DAILY_REQUESTS, overLimit } from "../src/limits";
import { retentionSweep } from "../src/retention";

const DAY = 86_400_000;

const call = (path: string, init?: RequestInit & { session?: string }) =>
  exports.default.fetch(`https://sync.test${path}`, {
    ...init,
    headers: {
      ...(init?.session ? { authorization: `Bearer ${init.session}` } : {}),
      ...(typeof init?.body === "string" && !init.body.startsWith("token=") ? { "content-type": "application/json" } : {}),
      ...((init?.headers as Record<string, string>) ?? {}),
    },
  });

/** A signed-in account that has never paid for BrewLM AI (ai_paid_since unset). */
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

async function subscribe(id: string, plan: string, status = "active", periodEnd = Date.now() + 30 * DAY) {
  await env.DB.prepare(
    `INSERT INTO subscriptions (user_id, polar_subscription_id, plan, status, current_period_end, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET plan = excluded.plan, status = excluded.status,
       current_period_end = excluded.current_period_end, updated_at = excluded.updated_at`
  )
    .bind(id, `sub-${id}`, plan, status, periodEnd, Date.now())
    .run();
}

const paidSince = async (id: string) =>
  (await env.DB.prepare("SELECT ai_paid_since FROM users WHERE id = ?").bind(id).first<{ ai_paid_since: number | null }>())?.ai_paid_since ?? null;
const setPaidSince = (id: string, at: number | null) => env.DB.prepare("UPDATE users SET ai_paid_since = ? WHERE id = ?").bind(at, id).run();
const row = (id: string) => env.DB.prepare("SELECT * FROM ai_accounts WHERE user_id = ?").bind(id).first<AiAccount>();
const keys = async () => (await (await fetch("https://openrouter.test/api/v1/__keys")).json()) as { hash: string; limit: number; usage: number }[];
const keyOf = async (id: string) => {
  const hash = (await row(id))?.key_hash;
  return (await keys()).find((k) => k.hash === hash);
};
const setUsage = (hash: string, usage: number) =>
  fetch("https://openrouter.test/api/v1/__usage", { method: "POST", body: JSON.stringify({ hash, usage }) });
const EMBED = { model: AI_CONFIG.roles.embedding.model, input: "hello", dimensions: 512 };
const ask = async (session: string) => {
  const res = await call("/v1/ai/openrouter/embeddings", { method: "POST", session, body: JSON.stringify(EMBED) });
  const body = (await res.json()) as { error?: { message: string } };
  return { status: res.status, error: body.error?.message };
};
const checkout = async (session: string, body: unknown) => {
  const res = await call("/v1/billing/checkout", { method: "POST", session, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as { url?: string; error?: string } };
};
const admin = { authorization: "Bearer admin-test-token" };

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

describe("the slow start", () => {
  it("holds a first paid plan to part of its allowance for a week, then unlocks the rest", async () => {
    const a = await account("ramp-max@example.com");
    await subscribe(a.id, "max");
    expect((await ask(a.session)).status).toBe(200);
    const r = (await row(a.id))!;
    expect(r.ramp_until).toBeGreaterThan(Date.now() + (AI_RAMP_DAYS - 1) * DAY);
    expect(await paidSince(a.id)).not.toBeNull();
    const held = Math.min(r.cap, rampAmount(AI_MONTHLY.max));
    expect((await keyOf(a.id))!.limit).toBeCloseTo(held, 4);

    const usage = (await (await call("/v1/ai/usage", { session: a.session })).json()) as { unlocksAt: number | null; usedFraction: number };
    expect(usage.unlocksAt).toBe(r.ramp_until);

    await setUsage(r.key_hash!, held);
    const refused = await ask(a.session);
    expect(refused.status).toBe(402);
    expect(refused.error).toMatch(/rest unlocks on/);

    // A week later (same month or the next), the slow start is over.
    const later = r.ramp_until! + 1000;
    const after = (await reconcile(env, a.id, later))!;
    expect(after.ramp_until).toBeNull();
    if (after.key_hash) expect((await keyOf(a.id))!.limit).toBeCloseTo(after.cap + after.topup - after.carried, 4);
  });

  it("starts when a trial converts, and never again for a returning subscriber", async () => {
    const a = await account("ramp-trial@example.com");
    await subscribe(a.id, "pro", "trialing");
    expect((await reconcile(env, a.id))!.ramp_until).toBeNull();
    expect(await paidSince(a.id)).toBeNull();

    await subscribe(a.id, "pro", "active");
    expect((await reconcile(env, a.id))!.ramp_until).not.toBeNull();

    // The plan lapses (its row goes at the month's end), then comes back: no second slow start.
    await subscribe(a.id, "pro", "canceled", Date.now() - 3 * DAY);
    expect((await reconcile(env, a.id))!.monthly).toBe(0);
    await env.DB.prepare("DELETE FROM ai_accounts WHERE user_id = ?").bind(a.id).run();
    await subscribe(a.id, "pro", "active");
    expect((await reconcile(env, a.id))!.ramp_until).toBeNull();
  });
});

describe("top-ups and blocked accounts", () => {
  it("opens top-ups 30 days after the first payment, at most two a month", async () => {
    const a = await account("topup-wait@example.com");
    await subscribe(a.id, "pro");
    await reconcile(env, a.id);
    const early = await checkout(a.session, { plan: "topup" });
    expect(early.status).toBe(403);
    expect(early.body.error).toMatch(/Top-ups open on/);

    await setPaidSince(a.id, Date.now() - 40 * DAY);
    expect((await checkout(a.session, { plan: "topup" })).body.url).toContain("prod-ai-topup");
    for (let i = 0; i < AI_TOPUPS_PER_MONTH; i++)
      await env.DB.prepare("INSERT INTO ai_topups (order_id, user_id, credit, net_amount, created_at) VALUES (?, ?, ?, 700, ?)")
        .bind(`order-wait-${i}`, a.id, AI_TOPUP_CREDIT, Date.now())
        .run();
    const full = await checkout(a.session, { plan: "topup" });
    expect(full.status).toBe(429);
    expect(full.body.error).toMatch(/the most for one month/);
  });

  it("refuses AI plans and top-ups to an account BrewLM AI is turned off for", async () => {
    const a = await account("blocked-buyer@example.com");
    const blocked = await call("/v1/admin/ai/block", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ email: "blocked-buyer@example.com", blocked: true, reason: "chargeback" }),
    });
    expect(blocked.status).toBe(200);
    expect((await checkout(a.session, { plan: "max", interval: "month" })).status).toBe(403);
    expect((await checkout(a.session, { plan: "sync", interval: "month" })).body.url).toContain("prod-sync-m");
    await subscribe(a.id, "pro");
    await setPaidSince(a.id, Date.now() - 40 * DAY);
    expect((await checkout(a.session, { plan: "topup" })).status).toBe(403);
  });
});

describe("refund quotes", () => {
  it("keeps the larger of the time used and the AI used, at the top-up's price", async () => {
    const a = await account("quote-max@example.com");
    await setPaidSince(a.id, Date.now() - 60 * DAY);
    await subscribe(a.id, "max");
    await send("order.paid", {
      id: "order-quote-1",
      status: "paid",
      paid: true,
      product_id: "prod-max-m",
      net_amount: 2500,
      refunded_amount: 0,
      created_at: new Date(Date.now() - 3 * DAY).toISOString(),
      customer: { external_id: a.id },
    });
    expect((await ask(a.session)).status).toBe(200);
    const r = (await row(a.id))!;
    const spent = Math.min(r.cap, 8);
    await setUsage(r.key_hash!, spent);

    const res = await call("/v1/admin/billing/refund-quote?email=quote-max@example.com", { headers: admin });
    expect(res.status).toBe(200);
    const q = (await res.json()) as { refundCents: number; aiValueCents: number; timeValueCents: number; summary: string };
    expect(q.aiValueCents).toBe(Math.round(spent * (AI_TOPUP_PRICE / AI_TOPUP_CREDIT) * 100));
    expect(q.refundCents).toBe(2500 - Math.min(2500, Math.max(q.timeValueCents, q.aiValueCents)));
    expect(q.summary).toMatch(/^Refund \$/);

    expect((await call("/v1/admin/billing/refund-quote?email=quote-max@example.com")).status).toBe(401);
  });
});

describe("limits", () => {
  it("stops an account over the day's request count until the next day", async () => {
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare("INSERT INTO request_days (user_id, day, n) VALUES ('flood-user', ?, ?)").bind(day, DAILY_REQUESTS).run();
    expect(await overLimit(env, "flood-user", Date.now(), () => 0)).toBe(DAILY_LIMIT);
    // Remembered without another sample.
    expect(await overLimit(env, "flood-user", Date.now(), () => 0.99)).toBe(DAILY_LIMIT);
    expect(await overLimit(env, "calm-user", Date.now(), () => 0)).toBeNull();
    expect(await overLimit(env, "flood-user", Date.now() + DAY, () => 0.99)).toBeNull();
  });

  it("grows the daily AI alert and ceiling with subscribers' allowances", () => {
    expect(limits(env)).toMatchObject({ alert: 20, ceiling: 60 });
    expect(limits(env, 2000)).toMatchObject({ alert: 80, ceiling: 200 });
  });
});

describe("data kept without a plan", () => {
  const HLC = (n: number) => `${String(Date.now()).padStart(13, "0")}:${String(n).padStart(4, "0")}:00000000-0000-0000-0000-000000000000`;

  it("warns twice, then deletes the server's copy and starts a new generation", async () => {
    const a = await account("lapsed@example.com");
    const now = Date.now();
    await env.DB.prepare("UPDATE users SET trial_ends_at = ? WHERE id = ?").bind(now - 200 * DAY, a.id).run();
    const vault = env.VAULT.get(env.VAULT.idFromName(a.id));
    await vault.putKeys("envelope", 0);
    await vault.push("00000000-0000-0000-0000-000000000000", [{ key: "k1", hlc: HLC(1), payload: "p1" }]);
    await env.BLOBS.put(`${a.id}/file1`, "hello");
    const obj = (await env.BLOBS.head(`${a.id}/file1`))!;
    await vault.adoptBlob("file1", obj.size, obj.uploaded.getTime());
    const before = await vault.pull(0, 10);

    const empty = await account("lapsed-empty@example.com");
    await env.DB.prepare("UPDATE users SET trial_ends_at = ? WHERE id = ?").bind(now - 200 * DAY, empty.id).run();
    const kept = await account("lapsed-paying@example.com");
    await env.DB.prepare("UPDATE users SET trial_ends_at = ? WHERE id = ?").bind(now - 200 * DAY, kept.id).run();
    await subscribe(kept.id, "sync");

    const ret = (id: string) => env.DB.prepare("SELECT * FROM retention WHERE user_id = ?").bind(id).first<Record<string, number | null>>();

    expect((await retentionSweep(env, now)).warned).toBeGreaterThanOrEqual(1);
    const first = (await ret(a.id))!;
    expect(first.warned_first_at).toBe(now);
    expect(first.delete_at).toBe(now + 30 * DAY); // lapsed long ago: never less than 30 days' notice
    expect((await ret(empty.id))!.deleted_at).toBe(now); // nothing stored: nothing to do
    expect(await ret(kept.id)).toBeNull();

    // Nothing happens until the last warning is due.
    await retentionSweep(env, now + 10 * DAY);
    expect((await ret(a.id))!.warned_last_at).toBeNull();
    await retentionSweep(env, now + 24 * DAY);
    expect((await ret(a.id))!.warned_last_at).toBe(now + 24 * DAY);
    await retentionSweep(env, now + 29 * DAY);
    expect((await vault.usage()).total).toBeGreaterThan(0);

    await retentionSweep(env, now + 31 * DAY);
    expect((await ret(a.id))!.deleted_at).toBe(now + 31 * DAY);
    expect((await vault.usage()).total).toBe(0);
    expect(await env.BLOBS.head(`${a.id}/file1`)).toBeNull();
    expect((await vault.getKeys()).envelope).toBe("envelope");
    const after = await vault.pull(0, 10);
    expect(after.changes).toEqual([]);
    expect(after.generation).toBe(before.generation + 1);
    // Sequence numbers keep going up, so no device's cursor is ahead of the vault.
    const pushed = await vault.push("00000000-0000-0000-0000-000000000000", [{ key: "k2", hlc: HLC(2), payload: "p2" }]);
    expect(pushed.cursor).toBeGreaterThan(before.cursor);
  });
});
