/**
 * Plans, the free trial and Polar billing.
 *
 * - Trial: 14 days from sign-up, no card. Plans: Sync (10 GB) and Sync Plus
 *   (100 GB), each billed monthly or yearly through Polar, the merchant of
 *   record. Polar products are named by env vars (POLAR_PRODUCT_*).
 * - Checkout and the billing portal are Polar-hosted pages the app opens in
 *   the browser; Polar's webhooks keep `subscriptions` current.
 * - Without an active plan or trial, sync is read-only: devices can still
 *   download their library but not upload.
 */
import { page, type User } from "./auth";

export type Plan = "trial" | "sync" | "plus" | "none";

const GB = 1024 ** 3;
export const LIMITS: Record<Plan, number> = { trial: 10 * GB, sync: 10 * GB, plus: 100 * GB, none: 10 * GB };
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

interface SubscriptionRow {
  plan: "sync" | "plus";
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

function productFor(env: Env, plan: string, interval: string): string | undefined {
  const key = `POLAR_PRODUCT_${plan.toUpperCase()}_${interval === "year" ? "YEARLY" : "MONTHLY"}` as keyof Env;
  const id = env[key];
  return typeof id === "string" && id ? id : undefined;
}

function planForProduct(env: Env, productId: string): "sync" | "plus" | null {
  if (productId === env.POLAR_PRODUCT_SYNC_MONTHLY || productId === env.POLAR_PRODUCT_SYNC_YEARLY) return "sync";
  if (productId === env.POLAR_PRODUCT_PLUS_MONTHLY || productId === env.POLAR_PRODUCT_PLUS_YEARLY) return "plus";
  return null;
}

async function polar(env: Env, path: string, body: unknown): Promise<Record<string, unknown>> {
  if (!env.POLAR_ACCESS_TOKEN) throw new Error("billing isn't configured on this server");
  const res = await fetch(`${env.POLAR_API_URL.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.POLAR_ACCESS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Polar HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/** POST /v1/billing/checkout { plan: "sync"|"plus", interval: "month"|"year" } → { url } */
export async function checkout(req: Request, env: Env, user: User): Promise<Response> {
  const body = await req.json<{ plan?: unknown; interval?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const plan = String(body.plan ?? "");
  const interval = String(body.interval ?? "");
  if (!["sync", "plus"].includes(plan) || !["month", "year"].includes(interval)) return json({ error: "bad plan" }, 400);
  const product = productFor(env, plan, interval);
  if (!product) return json({ error: "That plan isn't set up on this server yet." }, 503);
  try {
    const res = await polar(env, "/v1/checkouts/", {
      products: [product],
      customer_email: user.email,
      external_customer_id: user.id,
      success_url: `${env.PUBLIC_URL.replace(/\/$/, "")}/v1/billing/done`,
      metadata: { user_id: user.id },
    });
    return json({ url: res.url });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
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

/** POST /v1/webhooks/polar */
export async function polarWebhook(req: Request, env: Env): Promise<Response> {
  const body = await req.text();
  if (!(await verifyWebhook(env.POLAR_WEBHOOK_SECRET ?? "", req.headers, body))) return json({ error: "bad signature" }, 403);
  const event = JSON.parse(body) as { type?: string; data?: PolarSubscription };
  const fresh = await env.DB.prepare("INSERT OR IGNORE INTO webhook_events (id, received_at) VALUES (?, ?)")
    .bind(req.headers.get("webhook-id"), Date.now())
    .run();
  if (fresh.meta.changes === 0) return json({ ok: true, duplicate: true });
  if (!event.type?.startsWith("subscription.") || !event.data) return json({ ok: true, ignored: event.type });

  const sub = event.data;
  const userId = sub.customer?.external_id || (typeof sub.metadata?.user_id === "string" ? sub.metadata.user_id : "");
  const plan = planForProduct(env, sub.product_id);
  if (!userId || !plan) return json({ ok: true, ignored: "not a BrewLM Sync subscription" });
  const user = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(userId).first();
  if (!user) return json({ ok: true, ignored: "unknown user" });

  // Deliveries can arrive out of order: keep the most recently modified state.
  const modified = Date.parse(sub.modified_at ?? sub.created_at) || Date.now();
  await env.DB.prepare(
    `INSERT INTO subscriptions (user_id, polar_subscription_id, plan, status, current_period_end, cancel_at_period_end, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET polar_subscription_id = excluded.polar_subscription_id, plan = excluded.plan,
       status = excluded.status, current_period_end = excluded.current_period_end,
       cancel_at_period_end = excluded.cancel_at_period_end, updated_at = excluded.updated_at
     WHERE excluded.updated_at >= subscriptions.updated_at`
  )
    .bind(
      userId,
      sub.id,
      plan,
      sub.status,
      sub.current_period_end ? Date.parse(sub.current_period_end) : null,
      sub.cancel_at_period_end ? 1 : 0,
      modified
    )
    .run();
  return json({ ok: true });
}
