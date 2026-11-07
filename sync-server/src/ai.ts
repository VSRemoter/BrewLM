/**
 * BrewLM AI: Pro and Max subscribers get a monthly AI allowance, spent through
 * an OpenRouter key this server creates for them (openrouter.ts).
 *
 *   GET  /v1/ai/config   → which model does each job (aiConfig.ts); public
 *   POST /v1/ai/openrouter/{chat/completions,audio/speech,embeddings,images}
 *                        → OpenRouter's response, run on the account's key   (402 without an AI plan)
 *   GET  /v1/ai/usage    → { plan, trial, usedFraction, resetsAt, left: { chats, audioOverviews, … }, topupAdds }
 *
 * Rules (ai_accounts in D1, one row per account):
 * - A cycle is a calendar month (UTC). The allowance is the plan's monthly
 *   amount; the first month is prorated from when the plan started (at least
 *   the trial amount), and a mid-month plan change adds or removes the
 *   difference for the rest of the month — never below what's already spent.
 * - Spending is tracked per account, not per key: a key revoked mid-month
 *   (plan lapsed, refund) carries what it spent, so a new key only gets what's
 *   left. Each key's OpenRouter limit = cap + top-ups − carried.
 * - Top-ups (Polar one-time orders, billing.ts) add to the cycle's allowance.
 *   The plan's allowance is spent first; unused top-up credit carries into
 *   the next month for as long as the plan lasts.
 * - A key lives for one cycle: the first request of a new month deletes it and
 *   the next AI request creates a fresh one.
 *   Keys also expire on OpenRouter two days into the next month, as a backstop.
 * - The hourly cron (reconcileAll) grants new subscribers their allowance,
 *   revokes keys of lapsed plans, and rolls finished months over.
 *
 * The key never leaves this server (OpenRouter's terms forbid reselling API
 * access): the app's requests come through the proxy, which allows only the
 * config's models and endpoints. It's stored encrypted (AI_KEY_SECRET) and
 * never logged.
 */
import { userForSession, type User } from "./auth";
import { AI_CONFIG, AI_ESTIMATES, AI_MONTHLY, AI_TOPUP_CREDIT, AI_TRIAL } from "./aiConfig";
import { BLOCKED_MESSAGE, currentPause, isBlocked, PAUSED_MESSAGE } from "./aiGuard";
import { createKey, deleteKey, getKey, openKey, OpenRouterError, openRouterConfigured, sealKey, updateKey, usd } from "./openrouter";

const DAY = 86_400_000;
/** A renewal's webhook can lag the period end a little; AI stays on meanwhile. */
const PERIOD_GRACE_MS = DAY;
/** Keys expire on OpenRouter this long into the month after their cycle. */
const KEY_EXPIRY_SLACK_MS = 2 * DAY;
const AI_STATUSES = ["active", "trialing"];
const CRON_BATCH = 50;

export interface AiAccount {
  user_id: string;
  cycle: string;
  monthly: number;
  cap: number;
  topup: number;
  carried: number;
  key_hash: string | null;
  key_enc: string | null;
  key_created_at: number | null;
  rev: number;
  updated_at: number;
}

/* --------------------------------- months --------------------------------- */

export function cycleOf(now: number): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthStart(now: number, add = 0): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + add, 1);
}

/** Share of the current month still ahead, 0–1. */
export function restOfMonth(now: number): number {
  const start = monthStart(now);
  const end = monthStart(now, 1);
  return Math.min(1, Math.max(0, (end - now) / (end - start)));
}

/* ------------------------------- allowance -------------------------------- */

/** The account's monthly AI allowance by its subscription right now (0 = none). */
export async function monthlyAllowance(env: Env, userId: string, now = Date.now()): Promise<{ monthly: number; plan: string | null; trial: boolean }> {
  const sub = await env.DB.prepare("SELECT plan, status, current_period_end FROM subscriptions WHERE user_id = ?")
    .bind(userId)
    .first<{ plan: string; status: string; current_period_end: number | null }>();
  const none = { monthly: 0, plan: null, trial: false };
  if (!sub || !(sub.plan in AI_MONTHLY) || !AI_STATUSES.includes(sub.status)) return none;
  if (sub.current_period_end !== null && sub.current_period_end + PERIOD_GRACE_MS < now) return none;
  const trial = sub.status === "trialing";
  return { monthly: trial ? AI_TRIAL : AI_MONTHLY[sub.plan], plan: sub.plan, trial };
}

async function load(env: Env, userId: string): Promise<AiAccount | null> {
  return env.DB.prepare("SELECT * FROM ai_accounts WHERE user_id = ?").bind(userId).first<AiAccount>();
}

/** Writes `fields` if nobody else wrote the row since `rev` was read. */
async function save(env: Env, row: AiAccount, fields: Partial<Omit<AiAccount, "user_id" | "rev">>, now: number): Promise<boolean> {
  const cols = Object.keys(fields);
  const res = await env.DB.prepare(
    `UPDATE ai_accounts SET ${cols.map((c) => `${c} = ?`).join(", ")}, rev = rev + 1, updated_at = ?
     WHERE user_id = ? AND rev = ?`
  )
    .bind(...cols.map((c) => fields[c as keyof typeof fields] ?? null), now, row.user_id, row.rev)
    .run();
  return res.meta.changes === 1;
}

/** OpenRouter's limit for the account's key: what's left of this cycle's allowance. */
const keyLimit = (row: Pick<AiAccount, "cap" | "topup" | "carried">) => usd(row.cap + row.topup - row.carried);

/**
 * Brings the account's row (and its key's limit) in line with its plan and
 * the current month. Returns the row, or null when the account has no AI and
 * nothing left to track.
 */
export async function reconcile(env: Env, userId: string, now = Date.now()): Promise<AiAccount | null> {
  const cycle = cycleOf(now);
  for (let attempt = 0; attempt < 4; attempt++) {
    const { monthly } = await monthlyAllowance(env, userId, now);
    const row = await load(env, userId);

    if (!row) {
      if (monthly <= 0) return null;
      // First grant: the rest of this month, but never less than the trial amount.
      const cap = usd(Math.max(monthly * restOfMonth(now), Math.min(monthly, AI_TRIAL)));
      const ins = await env.DB.prepare(
        "INSERT OR IGNORE INTO ai_accounts (user_id, cycle, monthly, cap, updated_at) VALUES (?, ?, ?, ?, ?)"
      )
        .bind(userId, cycle, monthly, cap, now)
        .run();
      if (ins.meta.changes === 1) return load(env, userId);
      continue; // someone else created it first
    }

    if (row.cycle !== cycle) {
      // A new month: the old key retires with its month, and spending starts
      // over. Unused top-up credit (spent after the allowance) carries over.
      let spent = row.carried;
      if (row.key_hash) {
        spent += (await getKey(env, row.key_hash))?.usage ?? 0;
        await deleteKey(env, row.key_hash);
      }
      if (monthly <= 0) {
        const del = await env.DB.prepare("DELETE FROM ai_accounts WHERE user_id = ? AND rev = ?").bind(userId, row.rev).run();
        if (del.meta.changes === 1) return null;
        continue;
      }
      const topup = usd(Math.max(0, row.topup - Math.max(0, spent - row.cap)));
      const fresh = { cycle, monthly, cap: monthly, topup, carried: 0, key_hash: null, key_enc: null, key_created_at: null };
      if (await save(env, row, fresh, now)) return load(env, userId);
      continue;
    }

    if (monthly === row.monthly) return row;

    // The plan changed this month: add or remove the difference for the rest of it.
    const lowering = monthly < row.monthly;
    let carried = row.carried;
    let spent = carried;
    let key: Pick<AiAccount, "key_hash" | "key_enc" | "key_created_at"> = {
      key_hash: row.key_hash,
      key_enc: row.key_enc,
      key_created_at: row.key_created_at,
    };
    if (row.key_hash && lowering) {
      if (monthly <= 0) {
        // No more AI: stop the key first so the usage read is final, then delete it.
        await updateKey(env, row.key_hash, { disabled: true }).catch(() => {});
        carried += (await getKey(env, row.key_hash))?.usage ?? 0;
        spent = carried;
        await deleteKey(env, row.key_hash);
        key = { key_hash: null, key_enc: null, key_created_at: null };
      } else {
        spent += (await getKey(env, row.key_hash))?.usage ?? 0;
      }
    }
    let cap = row.cap + (monthly - row.monthly) * restOfMonth(now);
    if (lowering) cap = Math.max(cap, Math.min(row.cap, spent));
    const next = { monthly, cap: usd(cap), carried: usd(carried), ...key };
    if (!(await save(env, row, next, now))) continue;
    if (next.key_hash) await updateKey(env, next.key_hash, { limit: keyLimit({ ...row, ...next }) });
    return load(env, userId);
  }
  throw new Error("ai account busy");
}

/* -------------------------------- top-ups --------------------------------- */

/** What the account has spent this cycle: earlier keys plus the current one. */
async function spentThisCycle(env: Env, row: AiAccount): Promise<number> {
  return row.carried + (row.key_hash ? ((await getKey(env, row.key_hash))?.usage ?? 0) : 0);
}

/**
 * Adds a paid top-up order's credit, once per order (Polar may deliver the
 * same order in several events). An account without an AI plan keeps the
 * record but gets nothing; checkout only sells top-ups to Pro and Max.
 */
export async function applyTopup(env: Env, userId: string, orderId: string, credit: number, netAmount: number, now = Date.now()): Promise<void> {
  const ins = await env.DB.prepare(
    "INSERT OR IGNORE INTO ai_topups (order_id, user_id, credit, net_amount, created_at) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(orderId, userId, credit, netAmount, now)
    .run();
  if (ins.meta.changes === 0) return;
  try {
    await adjustTopup(env, userId, () => credit, now);
  } catch (e) {
    // Let Polar's retry apply it again.
    await env.DB.prepare("DELETE FROM ai_topups WHERE order_id = ?").bind(orderId).run();
    throw e;
  }
}

/** A (partial) refund of a top-up order takes back its share — never below what's already spent. */
export async function refundTopup(env: Env, userId: string, orderId: string, refundedAmount: number, now = Date.now()): Promise<void> {
  const t = await env.DB.prepare("SELECT credit, net_amount, refunded_amount FROM ai_topups WHERE order_id = ? AND user_id = ?")
    .bind(orderId, userId)
    .first<{ credit: number; net_amount: number; refunded_amount: number }>();
  if (!t || refundedAmount <= t.refunded_amount) return;
  const share = t.net_amount > 0 ? Math.min(1, (refundedAmount - t.refunded_amount) / t.net_amount) : 1;
  const res = await env.DB.prepare("UPDATE ai_topups SET refunded_amount = ? WHERE order_id = ? AND refunded_amount = ?")
    .bind(refundedAmount, orderId, t.refunded_amount)
    .run();
  if (res.meta.changes === 0) return; // another delivery of the same refund
  await adjustTopup(env, userId, (row, spent) => -Math.min(t.credit * share, Math.max(0, row.cap + row.topup - spent)), now);
}

/**
 * A refunded Pro or Max order: the refunded share of what's left of this
 * month's plan allowance goes (all of it for a full refund), once per order.
 * Top-up credit stays; ending the plan itself is Polar's subscription event.
 */
export async function refundPlanOrder(env: Env, userId: string, orderId: string, netAmount: number, refundedAmount: number, now = Date.now()): Promise<void> {
  if (refundedAmount <= 0) return;
  const prev = await env.DB.prepare("SELECT refunded_amount FROM ai_plan_refunds WHERE order_id = ?").bind(orderId).first<{ refunded_amount: number }>();
  const before = prev?.refunded_amount ?? 0;
  if (refundedAmount <= before) return;
  // Claim this refund's increase (another delivery of it changes nothing).
  const res = await env.DB.prepare(
    `INSERT INTO ai_plan_refunds (order_id, user_id, refunded_amount, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (order_id) DO UPDATE SET refunded_amount = excluded.refunded_amount WHERE ai_plan_refunds.refunded_amount = ?`
  )
    .bind(orderId, userId, refundedAmount, now, before)
    .run();
  if (res.meta.changes === 0) return;
  // This refund's share of the payment not refunded yet: a half refund then
  // the other half takes half of what's left, then all of the rest.
  const unrefunded = netAmount - before;
  const share = unrefunded > 0 ? Math.min(1, (refundedAmount - before) / unrefunded) : 1;
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await reconcile(env, userId, now);
    if (!row) return;
    const spent = await spentThisCycle(env, row);
    // The plan's allowance is spent before top-ups.
    const planLeft = Math.max(0, row.cap - Math.min(spent, row.cap));
    const cap = usd(row.cap - share * planLeft);
    if (!(await save(env, row, { cap }, now))) continue;
    if (row.key_hash) await updateKey(env, row.key_hash, { limit: keyLimit({ ...row, cap }) });
    return;
  }
  throw new Error("ai account busy");
}

/** Changes the cycle's top-up by `delta(row, spent)` and the key's limit with it. */
async function adjustTopup(env: Env, userId: string, delta: (row: AiAccount, spent: number) => number, now: number): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await reconcile(env, userId, now);
    if (!row) return;
    const spent = await spentThisCycle(env, row);
    const topup = usd(Math.max(0, row.topup + delta(row, spent)));
    if (!(await save(env, row, { topup }, now))) continue;
    if (row.key_hash) await updateKey(env, row.key_hash, { limit: keyLimit({ ...row, topup }) });
    return;
  }
  throw new Error("ai account busy");
}

/* --------------------------------- routes --------------------------------- */

const json = (body: unknown, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": cache, "x-content-type-options": "nosniff" },
  });
const fail = (status: number, error: string) => json({ error }, status);

const NO_AI = "BrewLM AI comes with the Pro and Max plans. Choose one in Settings → Sync, or add your own API key.";
const UNAVAILABLE = "BrewLM AI isn't available right now. Try again in a minute, or use your own API key.";
const SLOW_DOWN = "Too many requests. Wait a minute and try again.";

async function flooding(env: Env, userId: string): Promise<boolean> {
  return !(await env.ACCOUNT_RATE.limit({ key: userId })).success;
}

/**
 * The account's OpenRouter key, created on first use each month. It never
 * leaves this server: OpenRouter's terms don't allow handing out API access,
 * so the app sends its AI requests through proxy() instead.
 */
async function accountKey(env: Env, userId: string, now = Date.now()): Promise<{ key: string; row: AiAccount } | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await reconcile(env, userId, now);
    if (!row || row.monthly <= 0) return null;
    if (row.key_enc) return { key: await openKey(env, row.key_enc), row };

    const created = await createKey(env, {
      name: `brewlm:${userId}`,
      limit: keyLimit(row),
      expiresAt: new Date(monthStart(now, 1) + KEY_EXPIRY_SLACK_MS),
    });
    const sealed = await sealKey(env, created.key);
    const res = await env.DB.prepare(
      `UPDATE ai_accounts SET key_hash = ?, key_enc = ?, key_created_at = ?, rev = rev + 1, updated_at = ?
       WHERE user_id = ? AND rev = ? AND key_hash IS NULL`
    )
      .bind(created.info.hash, sealed, now, now, userId, row.rev)
      .run();
    if (res.meta.changes === 1) return { key: created.key, row: (await load(env, userId))! };
    // Another request got there first (or the row changed): drop ours, use theirs.
    await deleteKey(env, created.info.hash);
  }
  throw new Error("ai account busy");
}

/** Drops a key OpenRouter no longer accepts (deleted or expired out of band), keeping what it spent. */
async function forgetKey(env: Env, row: AiAccount, now = Date.now()): Promise<void> {
  if (!row.key_hash) return;
  const spent = (await getKey(env, row.key_hash))?.usage ?? 0;
  await deleteKey(env, row.key_hash);
  await save(env, row, { carried: usd(row.carried + spent), key_hash: null, key_enc: null, key_created_at: null }, now);
}

/* ---------------------------------- proxy --------------------------------- */

/** The OpenRouter endpoints BrewLM's features use; nothing else is forwarded. */
const PROXIED = new Set(["chat/completions", "audio/speech", "embeddings", "images"]);
/** Transcription sends up to 25 MB of audio as base64 inside the JSON. */
const MAX_PROXY_BODY = 40 * 1024 * 1024;
/** Variants of an allowed model that OpenRouter serves the same way (web search). */
const MODEL_SUFFIXES = [":online"];

/** Every model the config uses (any id with a "/"; voices have none): subscribers can run these and only these. */
export const ALLOWED_MODELS: ReadonlySet<string> = (() => {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      if (v.includes("/")) out.add(v);
    } else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(AI_CONFIG.tiers);
  walk(AI_CONFIG.more);
  walk(AI_CONFIG.roles);
  return out;
})();

export function modelAllowed(model: unknown): boolean {
  if (typeof model !== "string") return false;
  const suffix = MODEL_SUFFIXES.find((s) => model.endsWith(s));
  return ALLOWED_MODELS.has(suffix ? model.slice(0, -suffix.length) : model);
}

/** Errors in OpenRouter's shape ({ error: { message, code } }), which the app already reads. */
const orFail = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { message, code: status } }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });

const resetDate = (now: number) =>
  new Date(monthStart(now, 1)).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

/**
 * POST /v1/ai/openrouter/<endpoint>: forwards one of BrewLM's AI requests to
 * OpenRouter with the account's key, for a model the config allows. The
 * request is OpenRouter's own format, so the app only swaps the base URL and
 * sends its BrewLM session in place of a key. Streams pass straight through.
 */
async function proxy(req: Request, env: Env, user: User, endpoint: string, now = Date.now()): Promise<Response> {
  if (!PROXIED.has(endpoint)) return orFail(404, "BrewLM AI doesn't offer that.");
  if (Number(req.headers.get("content-length") ?? 0) > MAX_PROXY_BODY) return orFail(413, "That request is too large.");
  const raw = await req.text();
  if (raw.length > MAX_PROXY_BODY) return orFail(413, "That request is too large.");
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
  } catch {
    return orFail(400, "The request isn't valid JSON.");
  }
  if (!modelAllowed(body.model)) return orFail(403, `BrewLM AI doesn't run ${typeof body.model === "string" ? body.model : "that model"}. Pick a model in Settings → AI Model, or use your own API key.`);
  // Fallback lists would let a request reach other models.
  if (Array.isArray(body.models) && !body.models.every(modelAllowed)) return orFail(403, "BrewLM AI doesn't run one of those models.");
  // The kill switch, and accounts BrewLM AI is turned off for (aiGuard.ts).
  if (await currentPause(env, now)) return orFail(503, PAUSED_MESSAGE);
  if (await isBlocked(env, user.id)) return orFail(403, BLOCKED_MESSAGE);
  // OpenRouter's per-user id, for its abuse checks; the account id is opaque.
  if (endpoint === "chat/completions") body.user = user.id;
  const payload = JSON.stringify(body);

  for (let attempt = 0; attempt < 2; attempt++) {
    const acct = await accountKey(env, user.id, now);
    if (!acct) return orFail(402, NO_AI);
    const res = await fetch(`${env.OPENROUTER_API_URL.replace(/\/$/, "")}/${endpoint}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${acct.key}`,
        "content-type": "application/json",
        "http-referer": "https://brewlm.app",
        "x-title": "BrewLM",
      },
      body: payload,
      signal: req.signal,
    });
    if (res.status === 401 && attempt === 0) {
      // The key was deleted or expired on OpenRouter's side: replace it once.
      await res.body?.cancel();
      await forgetKey(env, acct.row, now);
      continue;
    }
    if (res.status === 402) {
      await res.body?.cancel();
      // The account's own limit, or BrewLM's OpenRouter credit running out?
      const info = acct.row.key_hash ? await getKey(env, acct.row.key_hash) : null;
      if (info && info.limit !== null && info.usage >= info.limit - 0.0001)
        return orFail(402, `You've used this month's BrewLM AI. It refills on ${resetDate(now)}, or add a top-up in Settings → Sync to keep going now.`);
      console.error("ai proxy: OpenRouter refused for credit while the key has room; top up the OpenRouter account");
      return orFail(503, UNAVAILABLE);
    }
    const headers = new Headers({ "cache-control": "no-store", "x-content-type-options": "nosniff" });
    const type = res.headers.get("content-type");
    if (type) headers.set("content-type", type);
    return new Response(res.body, { status: res.status, headers });
  }
  return orFail(503, UNAVAILABLE);
}

/** GET /v1/ai/usage: how much of this month's allowance is left, as counts (never dollars). */
async function usage(env: Env, user: User, now = Date.now()): Promise<Response> {
  const row = await reconcile(env, user.id, now);
  const { plan, trial } = await monthlyAllowance(env, user.id, now);
  const resetsAt = monthStart(now, 1);
  // Paused for everyone (or off for this account): the app says so instead of a meter alone.
  const paused = !!(await currentPause(env, now)) || (await isBlocked(env, user.id));
  if (!row || row.monthly <= 0) return json({ plan: null, trial: false, usedFraction: 0, resetsAt, left: null, paused });
  const allowance = row.cap + row.topup;
  const spent = await spentThisCycle(env, row);
  const remaining = Math.max(0, allowance - spent);
  const counts = (usd: number) => Object.fromEntries(Object.entries(AI_ESTIMATES).map(([k, cost]) => [k, Math.floor(usd / cost)]));
  const left = counts(remaining);
  return json({
    plan,
    trial,
    usedFraction: allowance > 0 ? Math.min(1, Math.round((spent / allowance) * 1000) / 1000) : 1,
    resetsAt,
    left,
    // What one top-up adds, in the same counts.
    topupAdds: counts(AI_TOPUP_CREDIT),
    paused,
  });
}

/** The /v1/ai routes, or null when the path isn't one. */
export async function aiRoutes(req: Request, env: Env, path: string): Promise<Response | null> {
  if (!path.startsWith("/v1/ai/")) return null;
  if (path === "/v1/ai/config") {
    if (req.method !== "GET") return fail(405, "method not allowed");
    return json(AI_CONFIG, 200, "public, max-age=300");
  }
  const proxied = path.startsWith("/v1/ai/openrouter/") ? path.slice("/v1/ai/openrouter/".length) : null;
  const route = proxied !== null ? "POST" : path === "/v1/ai/usage" ? "GET" : null;
  if (!route) return fail(404, "not found");
  if (req.method !== route) return fail(405, "method not allowed");
  const err = proxied !== null ? orFail : fail;
  const user = await userForSession(env, req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
  if (!user) return err(401, "Signed out of BrewLM. Sign in again in Settings → Sync.");
  if (await flooding(env, user.id)) return err(429, SLOW_DOWN);
  if (!openRouterConfigured(env)) return err(503, UNAVAILABLE);
  try {
    return proxied !== null ? await proxy(req, env, user, proxied) : await usage(env, user);
  } catch (e) {
    if (req.signal.aborted) return err(499, "cancelled");
    // OpenRouter's own message, never the key.
    console.error(`ai ${path}: ${e instanceof OpenRouterError ? e.message : e instanceof Error ? e.message : String(e)}`);
    return err(503, UNAVAILABLE);
  }
}

/* ---------------------------------- cron ---------------------------------- */

/**
 * Hourly: new subscribers get their allowance (so the first month is prorated
 * from when they subscribed, not first use), lapsed plans lose their keys,
 * and last month's rows roll over. Each batch is capped; the rest wait an hour.
 */
export async function reconcileAll(env: Env, now = Date.now()): Promise<{ checked: number; failed: number }> {
  if (!openRouterConfigured(env)) return { checked: 0, failed: 0 };
  const plans = Object.keys(AI_MONTHLY);
  const inPlans = plans.map(() => "?").join(", ");
  const inStatuses = AI_STATUSES.map(() => "?").join(", ");
  const queries = [
    // Subscribed, no row yet.
    env.DB.prepare(
      `SELECT s.user_id FROM subscriptions s LEFT JOIN ai_accounts a ON a.user_id = s.user_id
       WHERE a.user_id IS NULL AND s.plan IN (${inPlans}) AND s.status IN (${inStatuses})
         AND (s.current_period_end IS NULL OR s.current_period_end + ? >= ?) LIMIT ${CRON_BATCH}`
    ).bind(...plans, ...AI_STATUSES, PERIOD_GRACE_MS, now),
    // Last month's rows.
    env.DB.prepare(`SELECT user_id FROM ai_accounts WHERE cycle != ? LIMIT ${CRON_BATCH}`).bind(cycleOf(now)),
    // Still holding an allowance, but the plan is gone.
    env.DB.prepare(
      `SELECT a.user_id FROM ai_accounts a LEFT JOIN subscriptions s ON s.user_id = a.user_id
       WHERE a.monthly > 0 AND (s.user_id IS NULL OR s.plan NOT IN (${inPlans}) OR s.status NOT IN (${inStatuses})
         OR (s.current_period_end IS NOT NULL AND s.current_period_end + ? < ?)) LIMIT ${CRON_BATCH}`
    ).bind(...plans, ...AI_STATUSES, PERIOD_GRACE_MS, now),
  ];
  const ids = new Set<string>();
  for (const q of queries) for (const r of (await q.all<{ user_id: string }>()).results) ids.add(r.user_id);
  let failed = 0;
  for (const id of ids) {
    try {
      await reconcile(env, id, now);
    } catch (e) {
      failed++;
      console.error(`ai reconcile ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { checked: ids.size, failed };
}
