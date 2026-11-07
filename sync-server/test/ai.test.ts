import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { cycleOf, reconcile, reconcileAll, restOfMonth, type AiAccount } from "../src/ai";
import { AI_CONFIG, AI_ESTIMATES, AI_MONTHLY, AI_TOPUP_CREDIT, AI_TRIAL } from "../src/aiConfig";
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

const EMBED = { model: AI_CONFIG.roles.embedding.model, input: "hello", dimensions: 512 };
/** One AI request through the proxy (an embedding by default). */
async function ask(session: string | undefined, body: unknown = EMBED, endpoint = "embeddings") {
  const res = await call(`/v1/ai/openrouter/${endpoint}`, { method: "POST", session, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, error: res.headers.get("content-type")?.includes("json") ? (JSON.parse(text) as { error?: { message: string } }).error?.message : undefined, headers: res.headers };
}
/** The last request the fake OpenRouter received. */
/** The last request the fake OpenRouter received on this key. */
const last = async (hash: string) =>
  (await (await fetch(`https://openrouter.test/api/v1/__last?hash=${hash}`)).json()) as { path: string; auth: string; referer: string; body: Record<string, unknown> };
const getKey = (session: string) => ask(session);

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
    expect((await ask(undefined)).status).toBe(401);
    const trialOnly = await account("trial-only@example.com");
    const none = await ask(trialOnly.session);
    expect(none.status).toBe(402);
    expect(none.error).toMatch(/Pro and Max/);
    const syncOnly = await account("sync-only@example.com", "sync");
    expect((await getKey(syncOnly.session)).status).toBe(402);
    expect((await call("/v1/ai/openrouter/embeddings", { session: syncOnly.session })).status).toBe(405);
    expect((await call("/v1/ai/key", { method: "POST", session: syncOnly.session })).status).toBe(404);
  });

  it("creates one prorated, capped key that stays on the server", async () => {
    const before = Date.now();
    const pro = await account("pro@example.com", "pro");
    const first = await getKey(pro.session);
    expect(first.status).toBe(200);
    expect(first.text).not.toMatch(/sk-or/);
    expect(first.headers.get("x-secret-upstream")).toBeNull();
    const mine = (await orKeys()).filter((k) => k.name === `brewlm:${pro.id}`);
    expect(mine).toHaveLength(1);
    expect((await last(mine[0].hash)).auth).toBe(`Bearer ${mine[0].key}`);
    await getKey(pro.session);
    expect((await orKeys()).filter((k) => k.name === `brewlm:${pro.id}`)).toHaveLength(1);

    const expected = Math.max(AI_MONTHLY.pro * restOfMonth(Date.now()), AI_TRIAL);
    expect(mine[0].limit).toBeCloseTo(expected, 2);
    expect(mine[0].limit).toBeLessThanOrEqual(AI_MONTHLY.pro * restOfMonth(before) + 0.001);
    // Expires two days into next month at the latest.
    expect(Date.parse(mine[0].expires_at)).toBeLessThan(nextMonth() + 2 * 86_400_000);

    const stored = await row(pro.id);
    expect(stored?.key_hash).toBe(mine[0].hash);
    expect(stored?.key_enc).not.toContain(mine[0].key.slice(9));
  });

  it("makes one key when two requests arrive at once", async () => {
    const pro = await account("race@example.com", "pro");
    const [a, b] = await Promise.all([getKey(pro.session), getKey(pro.session)]);
    expect([a.status, b.status]).toEqual([200, 200]);
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

describe("BrewLM AI proxy", () => {
  it("runs only the config's models and endpoints", async () => {
    const p = await account("proxy-models@example.com", "pro");
    const chat = { model: AI_CONFIG.tiers.smart.model, messages: [{ role: "user", content: "hi" }], stream: true };
    const ok = await ask(p.session, chat, "chat/completions");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("text/event-stream");
    expect(ok.text).toContain("[DONE]");
    const sent = await last((await row(p.id))!.key_hash!);
    expect(sent.body.user).toBe(p.id);
    expect(sent.referer).toBe("https://brewlm.app");

    expect((await ask(p.session, { ...chat, model: `${AI_CONFIG.tiers.smart.model}:online` }, "chat/completions")).status).toBe(200);
    expect((await ask(p.session, { ...chat, model: AI_CONFIG.more[0].model }, "chat/completions")).status).toBe(200);
    const other = await ask(p.session, { ...chat, model: "openai/gpt-9-ultra" }, "chat/completions");
    expect(other.status).toBe(403);
    expect(other.error).toMatch(/doesn't run openai\/gpt-9-ultra/);
    expect((await ask(p.session, { ...chat, models: [AI_CONFIG.tiers.fast.model, "openai/gpt-9-ultra"] }, "chat/completions")).status).toBe(403);
    expect((await ask(p.session, { model: AI_CONFIG.roles.tts.model, input: "hi", voice: "Puck" }, "audio/speech")).status).toBe(200);
    expect((await ask(p.session, EMBED, "keys")).status).toBe(404);
    expect((await ask(p.session, EMBED, "../keys")).status).toBe(404);
    expect((await call("/v1/ai/openrouter/embeddings", { method: "POST", session: p.session, body: "not json" })).status).toBe(400);
  });

  it("says when the month's allowance is used up, and blames nobody when BrewLM's credit is", async () => {
    const p = await account("proxy-spent@example.com", "pro");
    await getKey(p.session);
    const r = (await row(p.id))!;
    await setUsage(r.key_hash!, r.cap);
    const spent = await getKey(p.session);
    expect(spent.status).toBe(402);
    expect(spent.error).toMatch(/used this month's BrewLM AI/);
    // OpenRouter's own wording names the key's page and dollar amounts: none of it reaches the app.
    expect(spent.text).not.toMatch(/openrouter\.ai|\$|keys\//);

    await setUsage(r.key_hash!, 0);
    // Other errors keep their message, minus links and OpenRouter's details.
    const other = await ask(p.session, { ...EMBED, input: "fail/region" });
    expect(other.status).toBe(403);
    expect(other.error).toBe("Not available in your region. See");
    expect(other.text).not.toMatch(/openrouter\.ai|provider detail/);

    // BrewLM's own budget on OpenRouter is no fault of the subscriber's: "unavailable", no details.
    const budget = await ask(p.session, { ...EMBED, input: "fail/budget" });
    expect(budget.status).toBe(503);
    expect(budget.error).toMatch(/isn't available right now/);
    expect(budget.text).not.toMatch(/openrouter\.ai|\$|guardrail/i);

    await fetch("https://openrouter.test/api/v1/__broke", { method: "POST", body: JSON.stringify({ on: true }) });
    try {
      expect((await getKey(p.session)).status).toBe(503);
    } finally {
      await fetch("https://openrouter.test/api/v1/__broke", { method: "POST", body: JSON.stringify({ on: false }) });
    }
  });

  it("replaces a key OpenRouter no longer knows, keeping what it spent", async () => {
    const p = await account("proxy-lost@example.com", "max");
    await getKey(p.session);
    const old = (await row(p.id))!;
    await setUsage(old.key_hash!, 2);
    // Deleted on OpenRouter's side, behind the server's back.
    const k = (await orKeys()).find((x) => x.hash === old.key_hash)!;
    await fetch(`https://openrouter.test/api/v1/keys/${k.hash}`, { method: "PATCH", headers: { authorization: "Bearer or-mgmt-test" }, body: JSON.stringify({ disabled: true }) });

    expect((await getKey(p.session)).status).toBe(200);
    const now = (await row(p.id))!;
    expect(now.key_hash).not.toBe(old.key_hash);
    expect(now.carried).toBeCloseTo(2, 4);
    expect((await orKeys()).find((x) => x.hash === now.key_hash)?.limit).toBeCloseTo(now.cap + now.topup - 2, 4);
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
    expect(body.left.audioOverviews).toBe(Math.floor(r.cap / 2 / AI_ESTIMATES.audioOverviews));
    expect(body.resetsAt).toBe(nextMonth() - 3_600_000);
    expect((body as unknown as { topupAdds: Record<string, number> }).topupAdds.audioOverviews).toBe(Math.floor(AI_TOPUP_CREDIT / AI_ESTIMATES.audioOverviews));
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
