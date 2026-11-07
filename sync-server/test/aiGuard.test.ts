import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { AiAccount } from "../src/ai";
import { AI_CONFIG } from "../src/aiConfig";
import { currentPause, dailySummary, dayOf, setPause, spendWatch } from "../src/aiGuard";
import { sha256, verifySignIn } from "../src/auth";

const DAY = 86_400_000;
const ADMIN = { authorization: "Bearer admin-test-token" };

const call = (path: string, init?: RequestInit & { session?: string }) =>
  exports.default.fetch(`https://sync.test${path}`, {
    ...init,
    headers: {
      ...(init?.session ? { authorization: `Bearer ${init.session}` } : {}),
      ...(typeof init?.body === "string" && !init.body.startsWith("token=") ? { "content-type": "application/json" } : {}),
      ...((init?.headers as Record<string, string>) ?? {}),
    },
  });

async function account(email: string, plan?: string): Promise<{ session: string; id: string }> {
  const pendingId = `pending-${crypto.randomUUID()}`;
  const token = `token-${crypto.randomUUID()}`;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO sign_ins (pending_hash, token_hash, email, code, created_at, expires_at) VALUES (?, ?, ?, '1234', ?, ?)"
  )
    .bind(await sha256(pendingId), await sha256(token), email, now, now + 60_000)
    .run();
  await call("/v1/auth/verify", { method: "POST", body: `token=${encodeURIComponent(token)}`, headers: { "content-type": "application/x-www-form-urlencoded" } });
  const res = (await (await call("/v1/auth/poll", { method: "POST", body: JSON.stringify({ pendingId }) })).json()) as { session: string; vault: string };
  if (plan)
    await env.DB.prepare(
      `INSERT INTO subscriptions (user_id, polar_subscription_id, plan, status, current_period_end, updated_at) VALUES (?, ?, ?, 'active', ?, ?)`
    )
      .bind(res.vault, `sub-${res.vault}`, plan, now + 30 * DAY, now)
      .run();
  return { session: res.session, id: res.vault };
}

const EMBED = { model: AI_CONFIG.roles.embedding.model, input: "hello" };
async function ask(session: string) {
  const res = await call("/v1/ai/openrouter/embeddings", { method: "POST", session, body: JSON.stringify(EMBED) });
  const body = (await res.json()) as { error?: { message: string } };
  return { status: res.status, error: body.error?.message };
}
const admin = (path: string, body?: unknown) =>
  call(path, { method: body === undefined ? "GET" : "POST", headers: ADMIN, body: body === undefined ? undefined : JSON.stringify(body) });
const credits = (total: number, used: number) =>
  fetch("https://openrouter.test/api/v1/__credits", { method: "POST", body: JSON.stringify({ total, used }) });
const setUsage = (hash: string, usage: number) =>
  fetch("https://openrouter.test/api/v1/__usage", { method: "POST", body: JSON.stringify({ hash, usage }) });
const row = (id: string) => env.DB.prepare("SELECT * FROM ai_accounts WHERE user_id = ?").bind(id).first<AiAccount>();

afterEach(async () => {
  await setPause(env, null);
  await credits(100, 0);
});

describe("the kill switch", () => {
  it("is the admin's alone, and stops every BrewLM AI request until resumed", async () => {
    const p = await account("pause@example.com", "pro");
    expect((await ask(p.session)).status).toBe(200);
    expect((await call("/v1/admin/ai/pause", { method: "POST", body: JSON.stringify({ paused: true }) })).status).toBe(401);
    expect((await call("/v1/admin/ai/pause", { method: "POST", session: p.session, body: JSON.stringify({ paused: true }) })).status).toBe(401);

    expect((await admin("/v1/admin/ai/pause", { paused: true, reason: "testing" })).status).toBe(200);
    const paused = await ask(p.session);
    expect(paused.status).toBe(503);
    expect(paused.error).toMatch(/paused/);
    const usage = (await (await call("/v1/ai/usage", { session: p.session })).json()) as { paused: boolean };
    expect(usage.paused).toBe(true);
    const status = (await (await admin("/v1/admin/ai")).json()) as { paused: { by: string; reason: string } };
    expect(status.paused).toMatchObject({ by: "admin", reason: "testing" });

    await admin("/v1/admin/ai/pause", { paused: false });
    expect((await ask(p.session)).status).toBe(200);
  });

  it("turns BrewLM AI off for one blocked account", async () => {
    const bad = await account("abuser@example.com", "max");
    const good = await account("fine@example.com", "max");
    expect((await admin("/v1/admin/ai/block", { email: "abuser@example.com", blocked: true, reason: "scripted use" })).status).toBe(200);
    const blocked = await ask(bad.session);
    expect(blocked.status).toBe(403);
    expect(blocked.error).toMatch(/turned off for this account/);
    expect((await ask(good.session)).status).toBe(200);
    expect((await admin("/v1/admin/ai/block", { email: "nobody@example.com", blocked: true })).status).toBe(404);

    await admin("/v1/admin/ai/block", { email: "abuser@example.com", blocked: false });
    expect((await ask(bad.session)).status).toBe(200);
  });
});

describe("the spend watch", () => {
  it("emails at the alert, pauses at the ceiling until the next day, and warns once on low credit", async () => {
    const day1 = Date.UTC(2031, 0, 10, 9);
    await credits(500, 100);
    expect(await spendWatch(env, day1)).toMatchObject({ day: "2031-01-10", spent: 0, alerted: false, paused: false });

    await credits(500, 125); // $25 today: past the $20 alert
    expect(await spendWatch(env, day1 + 600_000)).toMatchObject({ spent: 25, alerted: true, paused: false });
    expect((await spendWatch(env, day1 + 1_200_000))?.alerted).toBe(false); // once a day

    await credits(500, 165); // $65: past the $60 ceiling
    const hit = await spendWatch(env, day1 + 1_800_000);
    expect(hit).toMatchObject({ spent: 65, paused: true });
    expect((await currentPause(env, day1 + 1_800_000))?.by).toBe("ceiling");
    expect(await currentPause(env, Date.UTC(2031, 0, 11, 0, 1))).toBeNull(); // lifts at midnight UTC

    // The next day starts from where the last check left off.
    await credits(500, 480); // $20 left: under the $25 low-balance mark
    const next = await spendWatch(env, Date.UTC(2031, 0, 11, 1));
    expect(next).toMatchObject({ day: "2031-01-11", spent: 315, lowBalance: true });
    expect((await spendWatch(env, Date.UTC(2031, 0, 11, 2)))?.lowBalance).toBe(false);
  });

  it("sums up yesterday the next morning, naming who used the most, once", async () => {
    const heavy = await account("heavy@example.com", "pro");
    await ask(heavy.session);
    const key = (await row(heavy.id))!.key_hash!;
    const d = Date.UTC(2031, 2, 5, 12);
    await credits(500, 200);
    await spendWatch(env, d);
    // The first summary only sets each account's mark.
    await credits(500, 203);
    await spendWatch(env, d + DAY);
    expect(await dailySummary(env, d + DAY + 3_600_000)).toContain(`BrewLM AI on ${dayOf(d)}`);
    expect(await dailySummary(env, d + DAY + 7_200_000)).toBeNull();

    await setUsage(key, 3); // three quarters of Pro's month in a day
    await credits(500, 206);
    await spendWatch(env, d + 2 * DAY);
    const text = (await dailySummary(env, d + 2 * DAY + 3_600_000))!;
    expect(text).toContain("Spent on OpenRouter: $3.00");
    expect(text).toMatch(/Used the most:\n(.*\n)*\s+heavy@example\.com: \$3\.00 that day/);
    expect(text).toMatch(/half a month's allowance or more in a day:\n\s+heavy@example\.com/);
    expect(text).toContain("/v1/admin/ai/block");
  });
});

describe("sign-up protection", () => {
  const start = (email: string) => call("/v1/auth/start", { method: "POST", body: JSON.stringify({ email }) });

  it("refuses throwaway inboxes for new accounts only", async () => {
    expect((await start("someone@mailinator.com")).status).toBe(400);
    expect((await start("someone@inbox.yopmail.com")).status).toBe(400);
    expect((await start("someone@gmail.com")).status).toBe(200);
    await env.DB.prepare("INSERT INTO users (id, email, created_at, trial_ends_at) VALUES (?, ?, ?, ?)")
      .bind(crypto.randomUUID(), "old@mailinator.com", Date.now(), Date.now())
      .run();
    expect((await start("old@mailinator.com")).status).toBe(200);
  });

  it("asks for a Turnstile check on the confirm page when it's set up", async () => {
    const on = { ...env, TURNSTILE_SITE_KEY: "site-test", TURNSTILE_SECRET: "turnstile-test-secret" } as unknown as Env;
    const token = `tok-${crypto.randomUUID()}`;
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO sign_ins (pending_hash, token_hash, email, code, created_at, expires_at) VALUES (?, ?, 'ts@example.com', '4321', ?, ?)"
    )
      .bind(await sha256(`p-${token}`), await sha256(token), now, now + 60_000)
      .run();
    const url = `http://127.0.0.1:8787/v1/auth/verify?token=${encodeURIComponent(token)}`;
    const approved = async () =>
      (await env.DB.prepare("SELECT approved_at FROM sign_ins WHERE token_hash = ?").bind(await sha256(token)).first<{ approved_at: number | null }>())?.approved_at;
    const post = (answer?: string) => {
      const form = new FormData();
      form.set("token", token);
      if (answer !== undefined) form.set("cf-turnstile-response", answer);
      return verifySignIn(new Request(url, { method: "POST", body: form }), on);
    };

    const page = await (await verifySignIn(new Request(url), on)).text();
    expect(page).toContain('class="cf-turnstile" data-sitekey="site-test" data-action="signin"');
    expect(page).toContain("challenges.cloudflare.com/turnstile/v0/api.js");

    for (const answer of [undefined, "", "nope", "wrong-action", "wrong-host"]) {
      expect(await (await post(answer)).text()).toContain("go through");
      expect(await approved()).toBeNull();
    }
    expect(await (await post("pass")).text()).toContain("You're signed in");
    expect(await approved()).toBeGreaterThan(0);
  });

  it("leaves the confirm page alone without Turnstile keys", async () => {
    const page = await (await call(`/v1/auth/verify?token=missing`)).text();
    expect(page).not.toContain("cf-turnstile");
  });
});
