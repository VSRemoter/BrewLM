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
import { applyTopup, monthlyAllowance, reconcile, refundTopup } from "./ai";
import { AI_TOPUP_CREDIT } from "./aiConfig";
import { page, type User } from "./auth";

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
}

export async function entitlement(env: Env, user: User): Promise<Entitlement> {
  const now = Date.now();
  const sub = await env.DB.prepare(
    "SELECT plan, status, current_period_end, cancel_at_period_end FROM subscriptions WHERE user_id = ?"
  )
    .bind(user.id)
    .first<SubscriptionRow>();
  const base = { trialEndsAt: user.trial_ends_at, periodEnd: null, cancelAtPeriodEnd: false };
  if (sub && PAYING.has(sub.status) && (sub.current_period_end === null || sub.current_period_end + GRACE_MS > now))
    return {
      ...base,
      plan: sub.plan,
      canSync: true,
      limitBytes: LIMITS[sub.plan],
      periodEnd: sub.current_period_end,
      cancelAtPeriodEnd: sub.cancel_at_period_end === 1,
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

async function subscriptionEvent(env: Env, sub: PolarSubscription): Promise<Response> {
  const userId = userIdOf(sub);
  const product = planForProduct(env, sub.product_id);
  if (!userId || !product) return json({ ok: true, ignored: "not a BrewLM subscription" });
  if (!(await knownUser(env, userId))) return json({ ok: true, ignored: "unknown user" });

  // Deliveries can arrive out of order: keep the most recently modified state.
  const modified = Date.parse(sub.modified_at ?? sub.created_at) || Date.now();
  await env.DB.prepare(
    `INSERT INTO subscriptions (user_id, polar_subscription_id, plan, status, current_period_end, cancel_at_period_end, updated_at, product_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET polar_subscription_id = excluded.polar_subscription_id, plan = excluded.plan,
       status = excluded.status, current_period_end = excluded.current_period_end,
       cancel_at_period_end = excluded.cancel_at_period_end, updated_at = excluded.updated_at,
       product_id = excluded.product_id
     WHERE excluded.updated_at >= subscriptions.updated_at`
  )
    .bind(
      userId,
      sub.id,
      product.plan,
      sub.status,
      sub.current_period_end ? Date.parse(sub.current_period_end) : null,
      sub.cancel_at_period_end ? 1 : 0,
      modified,
      sub.product_id
    )
    .run();
  // The AI allowance follows the plan right away (the hourly cron retries a failure).
  await reconcile(env, userId).catch((e) => console.error(`ai reconcile ${userId}: ${e instanceof Error ? e.message : String(e)}`));
  return json({ ok: true });
}

/**
 * AI top-ups: a paid order adds AI_TOPUP_CREDIT to the account's allowance; a
 * refund takes back the refunded share (never below what's already spent).
 * Refunds of subscription orders change nothing here: to cut AI off when
 * refunding, revoke the subscription in Polar (Polar does that itself when it
 * refunds to head off a chargeback), and its webhook revokes the key.
 */
async function orderEvent(env: Env, order: PolarOrder): Promise<Response> {
  const topupProduct = envString(env, "POLAR_PRODUCT_AI_TOPUP");
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
