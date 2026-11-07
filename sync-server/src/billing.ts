/**
 * Plans, the free trial and Polar billing.
 *
 * - Trial: 14 days from sign-up, no card. Plans: Sync (10 GB), Sync Plus
 *   (100 GB), and Pro (10 GB) and Max (100 GB) with BrewLM AI included
 *   (ai.ts), each billed monthly or yearly through Polar, the merchant of
 *   record. Pro and Max may carry a Polar trial (card required, set on the
 *   product). The AI top-up is a one-time product. Polar products are named by
 *   env vars (POLAR_PRODUCT_*).
 * - Checkout and the billing portal are Polar-hosted pages the app opens in
 *   the browser; Polar's webhooks keep `subscriptions` current.
 * - An account has one subscription: checkout refuses a second, and
 *   POST /v1/billing/change switches plans instead — upgrades now (Polar
 *   charges the prorated difference first), downgrades at the next renewal.
 * - Without an active plan or trial, sync is read-only: devices can still
 *   download their library but not upload.
 */
import { applyTopup, monthlyAllowance, reconcile, refundPlanOrder, refundTopup } from "./ai";
import { AI_TOPUP_CREDIT } from "./aiConfig";
import { page, type User } from "./auth";
import { sendAdminEmail } from "./email";

/** Pro and Max are Sync and Sync Plus with BrewLM AI included (ai.ts). */
export type Plan = "trial" | "sync" | "plus" | "pro" | "max" | "none";

const GB = 1024 ** 3;
export const LIMITS: Record<Plan, number> = {
  trial: 10 * GB,
  sync: 10 * GB,
  plus: 100 * GB,
  pro: 10 * GB,
  max: 100 * GB,
  none: 10 * GB,
};
/** Polar keeps retrying a failed renewal for a while; don't cut sync off meanwhile. */
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const PAYING = new Set(["active", "trialing", "past_due"]);

export interface Entitlement {
  plan: Plan;
  /** May this account upload? */
  canSync: boolean;
  limitBytes: number;
  trialEndsAt: number;
  /** Paid plans: when the current period ends (renewal or cancellation). */
  periodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  /** Paid plans: how it's billed (null when unknown, e.g. a product this server doesn't list). */
  interval: Interval | null;
}

type PaidPlan = "sync" | "plus" | "pro" | "max";
const PAID_PLANS: PaidPlan[] = ["sync", "plus", "pro", "max"];
/** Higher is more: moving up a rank is an upgrade. */
const RANK: Record<PaidPlan, number> = { sync: 1, plus: 2, pro: 3, max: 4 };
type Interval = "month" | "year";

interface SubscriptionRow {
  plan: PaidPlan;
  status: string;
  current_period_end: number | null;
  cancel_at_period_end: number;
  product_id: string | null;
}

export async function entitlement(env: Env, user: User): Promise<Entitlement> {
  const now = Date.now();
  const sub = await env.DB.prepare(
    "SELECT plan, status, current_period_end, cancel_at_period_end, product_id FROM subscriptions WHERE user_id = ?"
  )
    .bind(user.id)
    .first<SubscriptionRow>();
  const base = { trialEndsAt: user.trial_ends_at, periodEnd: null, cancelAtPeriodEnd: false, interval: null };
  if (sub && PAYING.has(sub.status) && (sub.current_period_end === null || sub.current_period_end + GRACE_MS > now))
    return {
      ...base,
      plan: sub.plan,
      canSync: true,
      limitBytes: LIMITS[sub.plan],
      periodEnd: sub.current_period_end,
      cancelAtPeriodEnd: sub.cancel_at_period_end === 1,
      interval: sub.product_id ? (planForProduct(env, sub.product_id)?.interval ?? null) : null,
    };
  if (user.trial_ends_at > now) return { ...base, plan: "trial", canSync: true, limitBytes: LIMITS.trial };
  return { ...base, plan: "none", canSync: false, limitBytes: LIMITS.none };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function envString(env: Env, key: string): string | undefined {
  const id = env[key as keyof Env];
  return typeof id === "string" && id ? id : undefined;
}

function productFor(env: Env, plan: PaidPlan, interval: Interval): string | undefined {
  return envString(env, `POLAR_PRODUCT_${plan.toUpperCase()}_${interval === "year" ? "YEARLY" : "MONTHLY"}`);
}

function planForProduct(env: Env, productId: string): { plan: PaidPlan; interval: Interval } | null {
  for (const plan of PAID_PLANS)
    for (const interval of ["month", "year"] as const) if (productId === productFor(env, plan, interval)) return { plan, interval };
  return null;
}

class PolarError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

async function polar(env: Env, path: string, body: unknown, method = "POST"): Promise<Record<string, unknown>> {
  if (!env.POLAR_ACCESS_TOKEN) throw new PolarError(503, "billing isn't configured on this server");
  const res = await fetch(`${env.POLAR_API_URL.replace(/\/$/, "")}${path}`, {
    method,
    headers: { authorization: `Bearer ${env.POLAR_ACCESS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new PolarError(res.status, `Polar HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const isPaidPlan = (p: string): p is PaidPlan => (PAID_PLANS as string[]).includes(p);
const isInterval = (i: string): i is Interval => i === "month" || i === "year";

/** The account's subscription when it still counts (so a second one would double-bill). */
async function liveSubscription(env: Env, userId: string) {
  const sub = await env.DB.prepare(
    "SELECT polar_subscription_id, plan, status, current_period_end, cancel_at_period_end FROM subscriptions WHERE user_id = ?"
  )
    .bind(userId)
    .first<SubscriptionRow & { polar_subscription_id: string }>();
  return sub && PAYING.has(sub.status) ? sub : null;
}

/**
 * POST /v1/billing/checkout → { url }
 *   { plan: "sync"|"plus"|"pro"|"max", interval: "month"|"year" }   a new subscription
 *   { plan: "topup" }                                                more AI this month (Pro/Max only)
 */
/**
 * Are the AI plans (Pro, Max) offered to this account? Off until launch:
 * AI_FOR_SALE=1 opens them to everyone; AI_EARLY_ACCESS (comma-separated
 * emails) lets those accounts see and buy them first. Both are secrets, so
 * `wrangler secret put AI_FOR_SALE` flips the switch without a deploy.
 * Accounts already on Pro or Max always keep theirs (checked by callers).
 */
export function aiForSale(env: Env, user: Pick<User, "email"> | null): boolean {
  if (env.AI_FOR_SALE === "1") return true;
  if (!user) return false;
  return (env.AI_EARLY_ACCESS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(user.email.toLowerCase());
}

const NOT_FOR_SALE = "BrewLM AI plans aren't available yet.";
const isAiPlan = (p: string) => p === "pro" || p === "max";

export async function checkout(req: Request, env: Env, user: User): Promise<Response> {
  const body = await req.json<{ plan?: unknown; interval?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const plan = String(body.plan ?? "");
  const interval = String(body.interval ?? "");
  let product: string | undefined;
  let kind = "subscription";
  if (plan === "topup") {
    if ((await monthlyAllowance(env, user.id)).monthly <= 0)
      return json({ error: "AI top-ups are for the Pro and Max plans." }, 402);
    product = envString(env, "POLAR_PRODUCT_AI_TOPUP");
    kind = "ai_topup";
  } else {
    if (!isPaidPlan(plan) || !isInterval(interval)) return json({ error: "bad plan" }, 400);
    if (isAiPlan(plan) && !aiForSale(env, user)) return json({ error: NOT_FOR_SALE }, 403);
    if (await liveSubscription(env, user.id))
      return json({ error: "You already have a plan. Change it instead of buying a second one.", change: true }, 409);
    product = productFor(env, plan, interval);
  }
  if (!product) return json({ error: "That plan isn't set up on this server yet." }, 503);
  try {
    const res = await polar(env, "/v1/checkouts/", {
      products: [product],
      customer_email: user.email,
      external_customer_id: user.id,
      success_url: `${env.PUBLIC_URL.replace(/\/$/, "")}/v1/billing/done`,
      metadata: { user_id: user.id, kind },
    });
    return json({ url: res.url });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
}

/**
 * POST /v1/billing/change { plan, interval } → { ok, when: "now"|"renewal" }
 *
 * Moves the account's subscription to another plan. Up a rank (or monthly →
 * yearly) applies now and Polar charges the prorated difference first: if
 * that payment fails, nothing changes (402). Down a rank (or yearly →
 * monthly) waits for the renewal, so nobody upgrades, spends Max's AI
 * allowance and drops back before paying. A pending cancellation is undone
 * first (Polar won't change a plan that's set to cancel).
 */
export async function changePlan(req: Request, env: Env, user: User): Promise<Response> {
  const body = await req.json<{ plan?: unknown; interval?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const plan = String(body.plan ?? "");
  const interval = String(body.interval ?? "");
  if (!isPaidPlan(plan) || !isInterval(interval)) return json({ error: "bad plan" }, 400);
  const product = productFor(env, plan, interval);
  if (!product) return json({ error: "That plan isn't set up on this server yet." }, 503);
  const sub = await liveSubscription(env, user.id);
  if (!sub) return json({ error: "You don't have a plan to change. Choose one instead." }, 409);
  // Before launch, only early access (or someone already on an AI plan) may move to one.
  if (isAiPlan(plan) && !isAiPlan(sub.plan) && !aiForSale(env, user)) return json({ error: NOT_FOR_SALE }, 403);
  // Unknown for subscriptions last updated before product ids were stored.
  const current = await currentInterval(env, sub.polar_subscription_id);
  if (sub.plan === plan && current === interval) return json({ error: "You're already on that plan." }, 400);
  const down = RANK[plan] < RANK[sub.plan] || (RANK[plan] === RANK[sub.plan] && current === "year" && interval === "month");
  const path = `/v1/subscriptions/${encodeURIComponent(sub.polar_subscription_id)}`;
  try {
    if (sub.cancel_at_period_end) await polar(env, path, { cancel_at_period_end: false }, "PATCH");
    await polar(env, path, { product_id: product, proration_behavior: down ? "next_period" : "invoice" }, "PATCH");
    return json({ ok: true, when: down ? "renewal" : "now" });
  } catch (e) {
    if (e instanceof PolarError && (e.status === 402 || e.status === 400 || e.status === 422))
      return json({ error: "The payment for the change didn't go through. Check your card in Manage billing and try again." }, 402);
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
}

/** The billing interval of the subscription's current product, as last seen by a webhook. */
async function currentInterval(env: Env, subscriptionId: string): Promise<Interval | null> {
  const row = await env.DB.prepare("SELECT product_id FROM subscriptions WHERE polar_subscription_id = ?")
    .bind(subscriptionId)
    .first<{ product_id: string | null }>();
  return row?.product_id ? (planForProduct(env, row.product_id)?.interval ?? null) : null;
}

/** POST /v1/billing/portal → { url } (Polar's page to change plan, card, or cancel) */
export async function portal(env: Env, user: User): Promise<Response> {
  try {
    const res = await polar(env, "/v1/customer-sessions/", {
      external_customer_id: user.id,
      return_url: `${env.PUBLIC_URL.replace(/\/$/, "")}/v1/billing/done`,
    });
    return json({ url: res.customer_portal_url });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
}

export function billingDone(): Response {
  return page("Thank you", `<h1>All set</h1><p>Return to BrewLM. Your plan updates there within a minute.</p>`);
}

/* -------------------------------- webhooks -------------------------------- */

function b64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function b64decode(s: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * Standard Webhooks signature check: HMAC-SHA256 over "<id>.<timestamp>.<body>",
 * sent as "v1,<base64>" entries. Polar's newer secrets are standard
 * ("whsec_" + base64 key); older ones use the UTF-8 bytes of the whole string.
 * Both are tried. Deliveries older than 5 minutes are refused (replay).
 */
export async function verifyWebhook(secret: string, headers: Headers, body: string, now = Date.now()): Promise<boolean> {
  const id = headers.get("webhook-id");
  const ts = headers.get("webhook-timestamp");
  const sigs = (headers.get("webhook-signature") ?? "")
    .split(" ")
    .map((s) => s.split(",")[1])
    .filter(Boolean);
  if (!id || !ts || sigs.length === 0 || !secret) return false;
  if (Math.abs(now / 1000 - Number(ts)) > 5 * 60) return false;
  const keys = [b64decode(secret.replace(/^whsec_/, "")), new TextEncoder().encode(secret)].filter(
    (k): k is Uint8Array => !!k && k.length > 0
  );
  const data = new TextEncoder().encode(`${id}.${ts}.${body}`);
  for (const k of keys) {
    const key = await crypto.subtle.importKey("raw", k as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const expected = new TextEncoder().encode(b64(await crypto.subtle.sign("HMAC", key, data)));
    for (const s of sigs) {
      const given = new TextEncoder().encode(s);
      if (given.length === expected.length && crypto.subtle.timingSafeEqual(given, expected)) return true;
    }
  }
  return false;
}

interface PolarSubscription {
  id: string;
  status: string;
  product_id: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  modified_at: string | null;
  created_at: string;
  metadata?: Record<string, unknown>;
  customer?: { external_id?: string | null };
}

interface PolarOrder {
  id: string;
  status: string;
  paid?: boolean;
  product_id: string | null;
  /** Cents, before tax. */
  net_amount: number;
  refunded_amount: number;
  metadata?: Record<string, unknown>;
  customer?: { external_id?: string | null };
}

const userIdOf = (d: { customer?: { external_id?: string | null }; metadata?: Record<string, unknown> }) =>
  d.customer?.external_id || (typeof d.metadata?.user_id === "string" ? d.metadata.user_id : "");

async function knownUser(env: Env, userId: string): Promise<boolean> {
  return !!userId && !!(await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(userId).first());
}

/** POST /v1/webhooks/polar */
export async function polarWebhook(req: Request, env: Env): Promise<Response> {
  const body = await req.text();
  if (!(await verifyWebhook(env.POLAR_WEBHOOK_SECRET ?? "", req.headers, body))) return json({ error: "bad signature" }, 403);
  const event = JSON.parse(body) as { type?: string; data?: unknown };
  const fresh = await env.DB.prepare("INSERT OR IGNORE INTO webhook_events (id, received_at) VALUES (?, ?)")
    .bind(req.headers.get("webhook-id"), Date.now())
    .run();
  if (fresh.meta.changes === 0) return json({ ok: true, duplicate: true });
  let res: Response;
  if (!event.data) res = json({ ok: true, ignored: event.type });
  else if (event.type?.startsWith("subscription.")) res = await subscriptionEvent(env, event.data as PolarSubscription);
  else if (event.type === "order.paid" || event.type === "order.refunded" || event.type === "order.updated")
    res = await orderEvent(env, event.data as PolarOrder);
  else res = json({ ok: true, ignored: event.type });
  // Not handled: forget the delivery so Polar's retry isn't taken for a duplicate.
  if (res.status >= 500) await env.DB.prepare("DELETE FROM webhook_events WHERE id = ?").bind(req.headers.get("webhook-id")).run();
  return res;
}

/** A subscription's state as stored (subscriptions, extra_subscriptions). */
interface SubState {
  polar_subscription_id: string;
  plan: PaidPlan;
  status: string;
  current_period_end: number | null;
  cancel_at_period_end: number;
  product_id: string | null;
  updated_at: number;
}

/** Still paid for (or within the grace after its period, while Polar retries a renewal)? */
const isLive = (s: Pick<SubState, "status" | "current_period_end">, now = Date.now()) =>
  PAYING.has(s.status) && (s.current_period_end === null || s.current_period_end + GRACE_MS > now);

async function writeMain(env: Env, userId: string, s: SubState): Promise<void> {
  // Deliveries can arrive out of order: keep the most recently modified state.
  await env.DB.prepare(
    `INSERT INTO subscriptions (user_id, polar_subscription_id, plan, status, current_period_end, cancel_at_period_end, updated_at, product_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET polar_subscription_id = excluded.polar_subscription_id, plan = excluded.plan,
       status = excluded.status, current_period_end = excluded.current_period_end,
       cancel_at_period_end = excluded.cancel_at_period_end, updated_at = excluded.updated_at,
       product_id = excluded.product_id
     WHERE excluded.updated_at >= subscriptions.updated_at OR excluded.polar_subscription_id != subscriptions.polar_subscription_id`
  )
    .bind(userId, s.polar_subscription_id, s.plan, s.status, s.current_period_end, s.cancel_at_period_end, s.updated_at, s.product_id)
    .run();
}

async function writeExtra(env: Env, userId: string, s: SubState): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO extra_subscriptions (polar_subscription_id, user_id, plan, status, current_period_end, cancel_at_period_end, product_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (polar_subscription_id) DO UPDATE SET plan = excluded.plan, status = excluded.status,
       current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end,
       product_id = excluded.product_id, updated_at = excluded.updated_at
     WHERE excluded.updated_at >= extra_subscriptions.updated_at`
  )
    .bind(s.polar_subscription_id, userId, s.plan, s.status, s.current_period_end, s.cancel_at_period_end, s.product_id, s.updated_at)
    .run();
}

/** Tell the admin, once per extra subscription, which one to refund. */
async function reportDuplicate(env: Env, userId: string, kept: SubState, extra: SubState): Promise<void> {
  const claim = await env.DB.prepare(
    "UPDATE extra_subscriptions SET notified_at = ? WHERE polar_subscription_id = ? AND notified_at IS NULL"
  )
    .bind(Date.now(), extra.polar_subscription_id)
    .run();
  if (claim.meta.changes === 0) return;
  const user = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(userId).first<{ email: string }>();
  const text = `${user?.email ?? userId} has two BrewLM subscriptions at once (usually two checkouts opened before either was paid):

  In use:  ${kept.plan} (Polar subscription ${kept.polar_subscription_id})
  Extra:   ${extra.plan} (Polar subscription ${extra.polar_subscription_id})

BrewLM gives them the ${kept.plan} plan and ignores the extra one, so nothing's broken for them. They're paying twice, though: in Polar, revoke the extra subscription and refund its payment. If they meant to change plans, they can do that from Settings → Sync in BrewLM.`;
  try {
    await sendAdminEmail(env, `BrewLM: ${user?.email ?? userId} has two subscriptions`, text);
  } catch (e) {
    console.error(`duplicate subscription email: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * A subscription webhook. One account has one plan (`subscriptions`). A
 * second subscription that's live while the first is too goes to
 * `extra_subscriptions`: BrewLM uses the better plan of the two (never
 * downgrading someone for paying twice), emails the admin to refund the
 * extra, and promotes it if the plan in use ends while it's still paid for.
 */
async function subscriptionEvent(env: Env, sub: PolarSubscription): Promise<Response> {
  const userId = userIdOf(sub);
  const product = planForProduct(env, sub.product_id);
  if (!userId || !product) return json({ ok: true, ignored: "not a BrewLM subscription" });
  if (!(await knownUser(env, userId))) return json({ ok: true, ignored: "unknown user" });

  const now = Date.now();
  const incoming: SubState = {
    polar_subscription_id: sub.id,
    plan: product.plan,
    status: sub.status,
    current_period_end: sub.current_period_end ? Date.parse(sub.current_period_end) : null,
    cancel_at_period_end: sub.cancel_at_period_end ? 1 : 0,
    product_id: sub.product_id,
    updated_at: Date.parse(sub.modified_at ?? sub.created_at) || now,
  };
  const main = await env.DB.prepare(
    "SELECT polar_subscription_id, plan, status, current_period_end, cancel_at_period_end, product_id, updated_at FROM subscriptions WHERE user_id = ?"
  )
    .bind(userId)
    .first<SubState>();

  if (!main || main.polar_subscription_id === incoming.polar_subscription_id || !isLive(main, now)) {
    // The plan in use (or a new one replacing a plan that has ended).
    await writeMain(env, userId, incoming);
    await env.DB.prepare("DELETE FROM extra_subscriptions WHERE polar_subscription_id = ?").bind(incoming.polar_subscription_id).run();
    if (!isLive(incoming, now)) {
      // It ended: a still-paid extra subscription takes over.
      const { results } = await env.DB.prepare(
        "SELECT polar_subscription_id, plan, status, current_period_end, cancel_at_period_end, product_id, updated_at FROM extra_subscriptions WHERE user_id = ?"
      )
        .bind(userId)
        .all<SubState>();
      const next = results.filter((x) => isLive(x, now)).sort((a, b) => RANK[b.plan] - RANK[a.plan])[0];
      if (next) {
        await writeMain(env, userId, { ...next, updated_at: Math.max(next.updated_at, incoming.updated_at) });
        await env.DB.prepare("DELETE FROM extra_subscriptions WHERE polar_subscription_id = ?").bind(next.polar_subscription_id).run();
      }
    }
  } else if (!isLive(incoming, now)) {
    // An extra subscription ending (or an old one's late delivery): the plan in use stays.
    await writeExtra(env, userId, incoming);
  } else if (RANK[incoming.plan] > RANK[main.plan]) {
    // Two live subscriptions, the new one better: use it, and park the other.
    await writeExtra(env, userId, main);
    await writeMain(env, userId, incoming);
    await reportDuplicate(env, userId, incoming, main);
  } else {
    await writeExtra(env, userId, incoming);
    await reportDuplicate(env, userId, main, incoming);
  }
  // The AI allowance follows the plan right away (the hourly cron retries a failure).
  await reconcile(env, userId).catch((e) => console.error(`ai reconcile ${userId}: ${e instanceof Error ? e.message : String(e)}`));
  return json({ ok: true });
}

/**
 * Orders. AI top-ups: a paid order adds AI_TOPUP_CREDIT to the account's
 * allowance; a refund takes back the refunded share (never below what's
 * already spent). A refunded Pro or Max payment takes back that share of
 * what's left of this month's plan allowance (ai.ts refundPlanOrder). To stop
 * AI in later months too, revoke the subscription in Polar (Polar does that
 * itself when it refunds to head off a chargeback); its webhook ends the plan.
 */
async function orderEvent(env: Env, order: PolarOrder): Promise<Response> {
  const topupProduct = envString(env, "POLAR_PRODUCT_AI_TOPUP");
  const planned = order.product_id ? planForProduct(env, order.product_id) : null;
  if (planned && (planned.plan === "pro" || planned.plan === "max") && order.refunded_amount > 0) {
    // A refunded Pro/Max payment takes back that share of this month's AI.
    const userId = userIdOf(order);
    if (!(await knownUser(env, userId))) return json({ ok: true, ignored: "unknown user" });
    try {
      await refundPlanOrder(env, userId, order.id, order.net_amount, order.refunded_amount);
    } catch (e) {
      console.error(`ai plan refund ${order.id}: ${e instanceof Error ? e.message : String(e)}`);
      return json({ error: "try again" }, 503);
    }
    return json({ ok: true });
  }
  if (!topupProduct || order.product_id !== topupProduct) return json({ ok: true, ignored: "not an AI top-up" });
  const userId = userIdOf(order);
  if (!(await knownUser(env, userId))) return json({ ok: true, ignored: "unknown user" });
  const paid = order.paid === true || ["paid", "refunded", "partially_refunded"].includes(order.status);
  if (!paid) return json({ ok: true, ignored: "not paid yet" });
  try {
    await applyTopup(env, userId, order.id, AI_TOPUP_CREDIT, order.net_amount);
    if (order.refunded_amount > 0) await refundTopup(env, userId, order.id, order.refunded_amount);
  } catch (e) {
    // Polar retries the delivery; applying is idempotent per order.
    console.error(`ai topup ${order.id}: ${e instanceof Error ? e.message : String(e)}`);
    return json({ error: "try again" }, 503);
  }
  return json({ ok: true });
}
