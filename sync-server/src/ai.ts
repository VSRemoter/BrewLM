/**
 * BrewLM AI: Pro and Max subscribers get a monthly AI allowance, spent through
 * an OpenRouter key this server creates for them (openrouter.ts).
 *
 *   GET  /v1/ai/config   → which model does each job (aiConfig.ts); public
 *   POST /v1/ai/key      → { key, resetsAt, configVersion }   (402 without an AI plan)
 *   GET  /v1/ai/usage    → { plan, trial, usedFraction, resetsAt, left: { chats, audioOverviews, … } }
 *
 * Rules (ai_accounts in D1, one row per account):
 * - A cycle is a calendar month (UTC). The allowance is the plan's monthly
 *   amount; the first month is prorated from when the plan started (at least
 *   the trial amount), and a mid-month plan change adds or removes the
 *   difference for the rest of the month — never below what's already spent.
 * - Spending is tracked per account, not per key: a key revoked mid-month
 *   (plan lapsed, refund) carries what it spent, so a new key only gets what's
 *   left. Each key's OpenRouter limit = cap + top-ups − carried.
 * - A key lives for one cycle: the first request of a new month deletes it and
 *   the next POST /v1/ai/key creates a fresh one (a leaked key dies monthly).
 *   Keys also expire on OpenRouter two days into the next month, as a backstop.
 * - The hourly cron (reconcileAll) grants new subscribers their allowance,
 *   revokes keys of lapsed plans, and rolls finished months over.
 *
 * The key is stored encrypted (AI_KEY_SECRET) so every device of the account
 * gets the same one; it's never logged.
 */
import { userForSession, type User } from "./auth";
import { AI_CONFIG, AI_CONFIG_VERSION, AI_ESTIMATES, AI_MONTHLY, AI_TRIAL } from "./aiConfig";
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
      // A new month: the old key retires with its month, and spending starts over.
      if (row.key_hash) await deleteKey(env, row.key_hash);
      if (monthly <= 0) {
        const del = await env.DB.prepare("DELETE FROM ai_accounts WHERE user_id = ? AND rev = ?").bind(userId, row.rev).run();
        if (del.meta.changes === 1) return null;
        continue;
      }
      const fresh = { cycle, monthly, cap: monthly, topup: 0, carried: 0, key_hash: null, key_enc: null, key_created_at: null };
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

/** POST /v1/ai/key: the account's key, created on first use each month. */
async function issueKey(env: Env, user: User, now = Date.now()): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await reconcile(env, user.id, now);
    if (!row || row.monthly <= 0) return fail(402, NO_AI);
    const out = { resetsAt: monthStart(now, 1), configVersion: AI_CONFIG_VERSION };
    if (row.key_enc) return json({ key: await openKey(env, row.key_enc), ...out });

    const created = await createKey(env, {
      name: `brewlm:${user.id}`,
      limit: keyLimit(row),
      expiresAt: new Date(monthStart(now, 1) + KEY_EXPIRY_SLACK_MS),
    });
    const sealed = await sealKey(env, created.key);
    const res = await env.DB.prepare(
      `UPDATE ai_accounts SET key_hash = ?, key_enc = ?, key_created_at = ?, rev = rev + 1, updated_at = ?
       WHERE user_id = ? AND rev = ? AND key_hash IS NULL`
    )
      .bind(created.info.hash, sealed, now, now, user.id, row.rev)
      .run();
    if (res.meta.changes === 1) return json({ key: created.key, ...out });
    // Another device got there first (or the row changed): drop ours, use theirs.
    await deleteKey(env, created.info.hash);
  }
  return fail(503, UNAVAILABLE);
}

/** GET /v1/ai/usage: how much of this month's allowance is left, as counts (never dollars). */
async function usage(env: Env, user: User, now = Date.now()): Promise<Response> {
  const row = await reconcile(env, user.id, now);
  const { plan, trial } = await monthlyAllowance(env, user.id, now);
  const resetsAt = monthStart(now, 1);
  if (!row || row.monthly <= 0) return json({ plan: null, trial: false, usedFraction: 0, resetsAt, left: null });
  const keySpent = row.key_hash ? ((await getKey(env, row.key_hash))?.usage ?? 0) : 0;
  const allowance = row.cap + row.topup;
  const spent = row.carried + keySpent;
  const remaining = Math.max(0, allowance - spent);
  const left = Object.fromEntries(Object.entries(AI_ESTIMATES).map(([k, cost]) => [k, Math.floor(remaining / cost)]));
  return json({
    plan,
    trial,
    usedFraction: allowance > 0 ? Math.min(1, Math.round((spent / allowance) * 1000) / 1000) : 1,
    resetsAt,
    left,
  });
}

/** The /v1/ai routes, or null when the path isn't one. */
export async function aiRoutes(req: Request, env: Env, path: string): Promise<Response | null> {
  if (!path.startsWith("/v1/ai/")) return null;
  if (path === "/v1/ai/config") {
    if (req.method !== "GET") return fail(405, "method not allowed");
    return json(AI_CONFIG, 200, "public, max-age=300");
  }
  const route = path === "/v1/ai/key" ? "POST" : path === "/v1/ai/usage" ? "GET" : null;
  if (!route) return fail(404, "not found");
  if (req.method !== route) return fail(405, "method not allowed");
  const user = await userForSession(env, req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
  if (!user) return fail(401, "unauthorized");
  if (await flooding(env, user.id)) return fail(429, SLOW_DOWN);
  if (!openRouterConfigured(env)) return fail(503, UNAVAILABLE);
  try {
    return path === "/v1/ai/key" ? await issueKey(env, user) : await usage(env, user);
  } catch (e) {
    // OpenRouter's own message, never the key.
    console.error(`ai ${path}: ${e instanceof OpenRouterError ? e.message : e instanceof Error ? e.message : String(e)}`);
    return fail(503, UNAVAILABLE);
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
