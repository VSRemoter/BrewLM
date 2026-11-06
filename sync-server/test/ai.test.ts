import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { cycleOf, reconcile, reconcileAll, restOfMonth, type AiAccount } from "../src/ai";
import { AI_CONFIG, AI_MONTHLY, AI_TRIAL } from "../src/aiConfig";
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

interface FakeKey {
  hash: string;
  key: string;
  name: string;
  limit: number;
  usage: number;
  expires_at: string;
}
const orKeys = async () => (await (await fetch("https://openrouter.test/api/v1/__keys")).json()) as FakeKey[];
const setUsage = (hash: string, usage: number) =>
  fetch("https://openrouter.test/api/v1/__usage", { method: "POST", body: JSON.stringify({ hash, usage }) });
const row = (id: string) => env.DB.prepare("SELECT * FROM ai_accounts WHERE user_id = ?").bind(id).first<AiAccount>();

/** A signed-in account; `plan` adds a subscription in `status`. */
async function account(email: string, plan?: string, status = "active"): Promise<{ session: string; id: string }> {
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
  if (plan) await subscribe(res.vault, plan, status);
  return { session: res.session, id: res.vault };
}

async function subscribe(id: string, plan: string, status = "active") {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO subscriptions (user_id, polar_subscription_id, plan, status, current_period_end, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET plan = excluded.plan, status = excluded.status, updated_at = excluded.updated_at`
  )
    .bind(id, `sub-${id}`, plan, status, now + 30 * 86_400_000, now)
    .run();
}

async function getKey(session: string) {
  const res = await call("/v1/ai/key", { method: "POST", session });
  return { status: res.status, body: (await res.json()) as { key?: string; error?: string; resetsAt?: number } };
}

const nextMonth = (now = Date.now()) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) + 3_600_000;
};

describe("BrewLM AI config", () => {
  it("is public and cacheable", async () => {
    const res = await call("/v1/ai/config");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age");
    const body = (await res.json()) as typeof AI_CONFIG;
    expect(body.tiers.fast.model).toBe(AI_CONFIG.tiers.fast.model);
    expect(body.roles.embedding.dims).toBe(512);
    expect(JSON.stringify(body)).not.toMatch(/\$|usd|cost/i);
  });
});

describe("BrewLM AI keys", () => {
  it("needs a session and an AI plan", async () => {
    expect((await call("/v1/ai/key", { method: "POST" })).status).toBe(401);
    const trialOnly = await account("trial-only@example.com");
    expect((await getKey(trialOnly.session)).status).toBe(402);
    const syncOnly = await account("sync-only@example.com", "sync");
    expect((await getKey(syncOnly.session)).status).toBe(402);
    expect((await call("/v1/ai/key", { session: syncOnly.session })).status).toBe(405);
  });

  it("creates one prorated, capped key and hands every device the same one", async () => {
    const before = Date.now();
    const pro = await account("pro@example.com", "pro");
    const first = await getKey(pro.session);
    expect(first.status).toBe(200);
    expect(first.body.key).toMatch(/^sk-or-v1-/);
    expect((await getKey(pro.session)).body.key).toBe(first.body.key);

    const mine = (await orKeys()).filter((k) => k.name === `brewlm:${pro.id}`);
    expect(mine).toHaveLength(1);
    const expected = Math.max(AI_MONTHLY.pro * restOfMonth(Date.now()), AI_TRIAL);
    expect(mine[0].limit).toBeCloseTo(expected, 2);
    expect(mine[0].limit).toBeLessThanOrEqual(AI_MONTHLY.pro * restOfMonth(before) + 0.001);
    // Expires two days into next month at the latest.
    expect(Date.parse(mine[0].expires_at)).toBeLessThan(nextMonth() + 2 * 86_400_000);

    const stored = await row(pro.id);
    expect(stored?.key_hash).toBe(mine[0].hash);
    expect(stored?.key_enc).not.toContain(first.body.key!.slice(9));
  });

  it("gives two devices asking at once the same key, leaving one on OpenRouter", async () => {
    const pro = await account("race@example.com", "pro");
    const [a, b] = await Promise.all([getKey(pro.session), getKey(pro.session)]);
    expect(a.body.key).toBe(b.body.key);
    expect((await orKeys()).filter((k) => k.name === `brewlm:${pro.id}`)).toHaveLength(1);
  });

  it("gives a plan's trial the trial allowance, and the rest of the month when it converts", async () => {
    const t = await account("trialing@example.com", "pro", "trialing");
    await getKey(t.session);
    const hash = (await row(t.id))!.key_hash!;
    expect((await orKeys()).find((k) => k.hash === hash)?.limit).toBeCloseTo(AI_TRIAL, 4);

    await subscribe(t.id, "pro", "active");
    await getKey(t.session);
    const raised = AI_TRIAL + (AI_MONTHLY.pro - AI_TRIAL) * restOfMonth(Date.now());
    expect((await orKeys()).find((k) => k.hash === hash)?.limit).toBeCloseTo(raised, 2);
  });

  it("adds the difference for the rest of the month on an upgrade", async () => {
    const u = await account("upgrade@example.com", "pro");
    await getKey(u.session);
    const before = (await row(u.id))!;
    await subscribe(u.id, "max");
    await getKey(u.session);
    const after = (await row(u.id))!;
    expect(after.monthly).toBe(AI_MONTHLY.max);
    expect(after.cap - before.cap).toBeCloseTo((AI_MONTHLY.max - AI_MONTHLY.pro) * restOfMonth(Date.now()), 2);
    expect((await orKeys()).find((k) => k.hash === after.key_hash)?.limit).toBeCloseTo(after.cap, 4);
  });

  it("revokes the key when the plan lapses, and a resubscribe only gets what's left", async () => {
    const l = await account("lapse@example.com", "pro");
    await getKey(l.session);
    const old = (await row(l.id))!;
    await setUsage(old.key_hash!, 1.25);

    await subscribe(l.id, "pro", "canceled");
    expect((await getKey(l.session)).status).toBe(402);
    expect((await orKeys()).some((k) => k.hash === old.key_hash)).toBe(false);
    const lapsed = (await row(l.id))!;
    expect(lapsed.carried).toBeCloseTo(1.25, 4);
    expect(lapsed.cap).toBeGreaterThanOrEqual(1.25); // never below what was spent
    expect(lapsed.key_hash).toBeNull();

    await subscribe(l.id, "pro", "active");
    const again = await getKey(l.session);
    expect(again.status).toBe(200);
    const fresh = (await row(l.id))!;
    const limit = (await orKeys()).find((k) => k.hash === fresh.key_hash)!.limit;
    expect(limit).toBeCloseTo(fresh.cap + fresh.topup - fresh.carried, 4);
    expect(limit).toBeLessThan(fresh.cap);
  });

  it("retires the key at the start of a new month and starts the full allowance", async () => {
    const r = await account("rollover@example.com", "max");
    await getKey(r.session);
    const old = (await row(r.id))!;
    await setUsage(old.key_hash!, 3);

    const later = nextMonth();
    const rolled = (await reconcile(env, r.id, later))!;
    expect(rolled.cycle).toBe(cycleOf(later));
    expect(rolled.cap).toBe(AI_MONTHLY.max);
    expect(rolled.carried).toBe(0);
    expect(rolled.key_hash).toBeNull();
    expect((await orKeys()).some((k) => k.hash === old.key_hash)).toBe(false);
  });
});

describe("BrewLM AI usage", () => {
  it("reports what's left as counts and a fraction, never dollars", async () => {
    const u = await account("usage@example.com", "pro");
    await getKey(u.session);
    const r = (await row(u.id))!;
    await setUsage(r.key_hash!, r.cap / 2);
    const res = await call("/v1/ai/usage", { session: u.session });
    const body = (await res.json()) as { plan: string; usedFraction: number; left: Record<string, number>; resetsAt: number };
    expect(body.plan).toBe("pro");
    expect(body.usedFraction).toBeCloseTo(0.5, 2);
    expect(body.left.audioOverviews).toBe(Math.floor(r.cap / 2 / 0.2));
    expect(body.resetsAt).toBe(nextMonth() - 3_600_000);
    expect(JSON.stringify(body)).not.toMatch(/cap|carried|usd/i);

    const none = await account("usage-none@example.com");
    const empty = (await (await call("/v1/ai/usage", { session: none.session })).json()) as { plan: string | null };
    expect(empty.plan).toBeNull();
  });
});

describe("BrewLM AI cron", () => {
  it("grants new subscribers before first use and revokes lapsed keys", async () => {
    const fresh = await account("cron-new@example.com", "max");
    const gone = await account("cron-gone@example.com", "pro");
    await getKey(gone.session);
    const goneHash = (await row(gone.id))!.key_hash!;
    await subscribe(gone.id, "pro", "canceled");

    const res = await reconcileAll(env);
    expect(res.failed).toBe(0);
    expect((await row(fresh.id))?.monthly).toBe(AI_MONTHLY.max);
    expect((await row(fresh.id))?.key_hash).toBeNull(); // the key waits for first use
    expect((await row(gone.id))?.monthly).toBe(0);
    expect((await orKeys()).some((k) => k.hash === goneHash)).toBe(false);
  });
});
