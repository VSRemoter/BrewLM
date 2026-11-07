/**
 * BrewLM AI protection (Phase A5). Each subscriber's spending is already
 * capped by their key's limit (ai.ts); this guards the service as a whole.
 *
 * - Pause (the kill switch): every BrewLM AI request is refused with a
 *   friendly 503, so spending stops at once (the keys never leave this
 *   server). Set by the admin (POST /v1/admin/ai/pause), by the daily
 *   spending ceiling (until the next UTC day), or, without a deploy, by the
 *   AI_PAUSED secret (`wrangler secret put AI_PAUSED` with 1).
 * - Blocks: BrewLM AI off for one account (abuse), whatever its plan.
 * - Spend watch (every 10 minutes): BrewLM's whole OpenRouter spend today,
 *   from OpenRouter's running total. An email at AI_DAILY_ALERT_USD, a pause
 *   at AI_DAILY_CEILING_USD, and an email when the credit left drops below
 *   AI_LOW_BALANCE_USD. Each fires at most once a day.
 * - Daily summary (first hourly run of each UTC day): yesterday's spend,
 *   credit left, subscribers and top-ups, the accounts that used the most,
 *   and any that used half a month's allowance or more in a day.
 *
 * Admin routes (ADMIN_TOKEN):
 *   GET  /v1/admin/ai          → { paused, today: { day, spent, balance }, limits }
 *   POST /v1/admin/ai/pause    { paused: boolean, reason? }
 *   POST /v1/admin/ai/block    { email, blocked: boolean, reason? }
 */
import { isAdmin } from "./auth";
import { sendAdminEmail } from "./email";
import { getCredits, listKeyUsage, openRouterConfigured } from "./openrouter";

const DAY_MS = 86_400_000;
/** How long one isolate trusts its copy of the pause switch. */
const PAUSE_TTL_MS = 10_000;
/** A day's use this large a share of the monthly allowance gets flagged in the summary… */
const FAST_SHARE = 0.5;
/** …when it's at least this many dollars. */
const FAST_MIN_USD = 1;
const TOP_ACCOUNTS = 5;

export const PAUSED_MESSAGE = "BrewLM AI is paused for a little while. Try again later, or use your own API key in Settings → AI Model.";
export const BLOCKED_MESSAGE = "BrewLM AI is turned off for this account. If you think that's a mistake, write to contact@brewlm.com.";

export interface Pause {
  by: "admin" | "ceiling" | "secret";
  reason: string;
  at: number;
  /** When it lifts by itself (the ceiling's: the next UTC day); null = until the admin resumes. */
  until: number | null;
}

interface AiDay {
  day: string;
  start_usage: number;
  last_usage: number;
  balance: number | null;
  alerted_at: number | null;
  ceiling_at: number | null;
  low_balance_at: number | null;
  summary_at: number | null;
}

export const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);
const nextDay = (now: number) => Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1);
const usd = (n: number) => `$${n.toFixed(2)}`;
const base = (env: Env) => env.PUBLIC_URL.replace(/\/$/, "");

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function limits(env: Env) {
  return {
    alert: num(env.AI_DAILY_ALERT_USD, 20),
    ceiling: num(env.AI_DAILY_CEILING_USD, 60),
    lowBalance: num(env.AI_LOW_BALANCE_USD, 25),
  };
}

/* ---------------------------------- pause --------------------------------- */

let pauseCache: { at: number; value: Pause | null } | null = null;

/** The pause in force, if any (the AI_PAUSED secret wins). */
export async function currentPause(env: Env, now = Date.now()): Promise<Pause | null> {
  if (env.AI_PAUSED && env.AI_PAUSED !== "0") return { by: "secret", reason: "AI_PAUSED is set", at: 0, until: null };
  if (!pauseCache || Math.abs(now - pauseCache.at) > PAUSE_TTL_MS) {
    const row = await env.DB.prepare("SELECT value FROM ai_state WHERE name = 'pause'").first<{ value: string }>();
    let value: Pause | null = null;
    try {
      value = row ? (JSON.parse(row.value) as Pause) : null;
    } catch {
      /* unreadable: treat as not paused */
    }
    pauseCache = { at: now, value };
  }
  const p = pauseCache.value;
  return p && (p.until === null || p.until > now) ? p : null;
}

export async function setPause(env: Env, pause: Pause | null, now = Date.now()): Promise<void> {
  if (pause)
    await env.DB.prepare(
      "INSERT INTO ai_state (name, value, updated_at) VALUES ('pause', ?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    )
      .bind(JSON.stringify(pause), now)
      .run();
  else await env.DB.prepare("DELETE FROM ai_state WHERE name = 'pause'").run();
  pauseCache = { at: now, value: pause };
}

/* ---------------------------------- blocks -------------------------------- */

export async function isBlocked(env: Env, userId: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 AS b FROM ai_blocks WHERE user_id = ?").bind(userId).first());
}

/* ------------------------------- spend watch ------------------------------ */

const pauseCmd = (env: Env, paused: boolean) =>
  `curl -X POST ${base(env)}/v1/admin/ai/pause -H "authorization: Bearer $ADMIN_TOKEN" -d '{"paused":${paused}}'`;
const blockCmd = (env: Env, email: string) =>
  `curl -X POST ${base(env)}/v1/admin/ai/block -H "authorization: Bearer $ADMIN_TOKEN" -d '{"email":"${email}","blocked":true,"reason":"…"}'`;

/** Sets a once-a-day marker; true for the one caller that set it. */
async function claim(env: Env, day: string, column: "alerted_at" | "ceiling_at" | "low_balance_at" | "summary_at", now: number) {
  const res = await env.DB.prepare(`UPDATE ai_days SET ${column} = ? WHERE day = ? AND ${column} IS NULL`).bind(now, day).run();
  return res.meta.changes === 1;
}

async function mail(env: Env, subject: string, text: string): Promise<void> {
  try {
    await sendAdminEmail(env, subject, text);
  } catch (e) {
    console.error(`ai guard email "${subject}": ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface SpendCheck {
  day: string;
  spent: number;
  balance: number;
  alerted: boolean;
  paused: boolean;
  lowBalance: boolean;
}

/** Every 10 minutes: today's spend against the alert and the ceiling, and the credit left. */
export async function spendWatch(env: Env, now = Date.now()): Promise<SpendCheck | null> {
  if (!openRouterConfigured(env)) return null;
  const { total, used } = await getCredits(env);
  const day = dayOf(now);
  const balance = total - used;
  let row = await env.DB.prepare("SELECT * FROM ai_days WHERE day = ?").bind(day).first<AiDay>();
  if (!row) {
    // The day starts where yesterday's last check left off (or here, the first time).
    const prev = await env.DB.prepare("SELECT last_usage FROM ai_days WHERE day = ?").bind(dayOf(now - DAY_MS)).first<{ last_usage: number }>();
    await env.DB.prepare("INSERT OR IGNORE INTO ai_days (day, start_usage, last_usage, balance) VALUES (?, ?, ?, ?)")
      .bind(day, Math.min(used, prev?.last_usage ?? used), used, balance)
      .run();
    row = (await env.DB.prepare("SELECT * FROM ai_days WHERE day = ?").bind(day).first<AiDay>())!;
  }
  await env.DB.prepare("UPDATE ai_days SET last_usage = ?, balance = ? WHERE day = ?").bind(used, balance, day).run();

  const spent = Math.max(0, used - row.start_usage);
  const l = limits(env);
  const out: SpendCheck = { day, spent, balance, alerted: false, paused: false, lowBalance: false };

  if (spent >= l.ceiling && (await claim(env, day, "ceiling_at", now))) {
    await setPause(env, { by: "ceiling", reason: `${usd(spent)} spent today, over the ${usd(l.ceiling)} ceiling`, at: now, until: nextDay(now) }, now);
    out.paused = true;
    await mail(
      env,
      `BrewLM AI paused: ${usd(spent)} spent today`,
      `BrewLM AI has spent ${usd(spent)} on OpenRouter today (UTC), over the daily ceiling of ${usd(l.ceiling)} (AI_DAILY_CEILING_USD), so it's paused for everyone until midnight UTC. Subscribers see "paused for a little while"; their own API keys still work.\n\nOpenRouter credit left: ${usd(balance)}.\n\nIf this is real demand, raise AI_DAILY_CEILING_USD and resume now:\n${pauseCmd(env, false)}\n\nIf it's abuse, the daily summary lists the accounts that used the most; tomorrow it resumes by itself unless you pause it:\n${pauseCmd(env, true)}`
    );
  } else if (spent >= l.alert && !row.ceiling_at && (await claim(env, day, "alerted_at", now))) {
    out.alerted = true;
    await mail(
      env,
      `BrewLM AI: ${usd(spent)} spent today`,
      `BrewLM AI has spent ${usd(spent)} on OpenRouter today (UTC), past the alert at ${usd(l.alert)} (AI_DAILY_ALERT_USD). It pauses itself at ${usd(l.ceiling)} (AI_DAILY_CEILING_USD).\n\nOpenRouter credit left: ${usd(balance)}.\n\nTo pause BrewLM AI for everyone now:\n${pauseCmd(env, true)}`
    );
  }

  if (balance < l.lowBalance && (await claim(env, day, "low_balance_at", now))) {
    out.lowBalance = true;
    await mail(
      env,
      `BrewLM AI: OpenRouter credit low (${usd(balance)} left)`,
      `BrewLM's OpenRouter account has ${usd(balance)} of credit left, under ${usd(l.lowBalance)} (AI_LOW_BALANCE_USD). When it runs out, every BrewLM AI request fails ("isn't available right now").\n\nAdd credit at https://openrouter.ai/settings/credits (or turn on auto top-up there).`
    );
  }
  return out;
}

/* ------------------------------ daily summary ----------------------------- */

interface AccountDay {
  userId: string;
  email: string;
  monthly: number;
  allowance: number;
  spentCycle: number;
  spentDay: number;
}

/** Each AI account's spend since the last summary, and the new marks. */
async function accountDays(env: Env, now: number): Promise<AccountDay[]> {
  const usage = await listKeyUsage(env);
  const { results } = await env.DB.prepare(
    `SELECT a.user_id, a.cycle, a.monthly, a.cap, a.topup, a.carried, a.key_hash, u.email, m.cycle AS mark_cycle, m.spent AS mark_spent
     FROM ai_accounts a JOIN users u ON u.id = a.user_id LEFT JOIN ai_marks m ON m.user_id = a.user_id`
  ).all<{
    user_id: string;
    cycle: string;
    monthly: number;
    cap: number;
    topup: number;
    carried: number;
    key_hash: string | null;
    email: string;
    mark_cycle: string | null;
    mark_spent: number | null;
  }>();
  const out: AccountDay[] = [];
  const marks: D1PreparedStatement[] = [];
  for (const r of results) {
    const spentCycle = r.carried + (r.key_hash ? (usage.get(r.key_hash) ?? 0) : 0);
    const before = r.mark_cycle === r.cycle ? (r.mark_spent ?? 0) : 0;
    out.push({
      userId: r.user_id,
      email: r.email,
      monthly: r.monthly,
      allowance: r.cap + r.topup,
      spentCycle,
      spentDay: Math.max(0, spentCycle - before),
    });
    marks.push(
      env.DB.prepare(
        "INSERT INTO ai_marks (user_id, cycle, spent, at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET cycle = excluded.cycle, spent = excluded.spent, at = excluded.at"
      ).bind(r.user_id, r.cycle, spentCycle, now)
    );
  }
  for (let i = 0; i < marks.length; i += 100) await env.DB.batch(marks.slice(i, i + 100));
  return out;
}

/**
 * The first hourly run of each UTC day: yesterday in one email. Returns the
 * text sent, or null when there was nothing to report or it went already.
 */
export async function dailySummary(env: Env, now = Date.now()): Promise<string | null> {
  if (!openRouterConfigured(env)) return null;
  const day = dayOf(now - DAY_MS);
  const row = await env.DB.prepare("SELECT * FROM ai_days WHERE day = ?").bind(day).first<AiDay>();
  if (!row || row.summary_at || !(await claim(env, day, "summary_at", now))) return null;

  const today = await env.DB.prepare("SELECT start_usage FROM ai_days WHERE day = ?").bind(dayOf(now)).first<{ start_usage: number }>();
  const spent = Math.max(0, (today?.start_usage ?? row.last_usage) - row.start_usage);
  const l = limits(env);
  const dayStart = Date.parse(`${day}T00:00:00Z`);

  const subs = (
    await env.DB.prepare(
      "SELECT plan, status, count(*) AS n FROM subscriptions WHERE plan IN ('pro', 'max') AND status IN ('active', 'trialing') GROUP BY plan, status"
    ).all<{ plan: string; status: string; n: number }>()
  ).results;
  const count = (plan: string, status?: string) => subs.filter((s) => s.plan === plan && (!status || s.status === status)).reduce((n, s) => n + s.n, 0);
  const topups = await env.DB.prepare("SELECT count(*) AS n FROM ai_topups WHERE created_at >= ? AND created_at < ?")
    .bind(dayStart, dayStart + DAY_MS)
    .first<{ n: number }>();
  const blocked = await env.DB.prepare("SELECT count(*) AS n FROM ai_blocks").first<{ n: number }>();
  const pause = await currentPause(env, now);

  let accounts: AccountDay[] = [];
  let accountsError = "";
  try {
    accounts = await accountDays(env, now);
  } catch (e) {
    accountsError = `(Couldn't read per-account use from OpenRouter: ${e instanceof Error ? e.message : String(e)})`;
  }
  const line = (a: AccountDay) =>
    `  ${a.email}: ${usd(a.spentDay)} that day, ${usd(a.spentCycle)} of ${usd(a.allowance)} this month`;
  const top = accounts.filter((a) => a.spentDay > 0).sort((a, b) => b.spentDay - a.spentDay).slice(0, TOP_ACCOUNTS);
  const fast = accounts.filter((a) => a.spentDay >= FAST_MIN_USD && a.spentDay >= FAST_SHARE * (a.monthly || a.allowance));

  const text = [
    `BrewLM AI on ${day} (UTC)`,
    "",
    `Spent on OpenRouter: ${usd(spent)} (alert at ${usd(l.alert)}, pause at ${usd(l.ceiling)})${row.ceiling_at ? " — hit the ceiling and paused" : ""}`,
    `OpenRouter credit left: ${row.balance === null ? "unknown" : usd(row.balance)}`,
    `Subscribers with AI: ${count("pro")} Pro, ${count("max")} Max (${count("pro", "trialing") + count("max", "trialing")} on trial)`,
    `Top-ups bought: ${topups?.n ?? 0}`,
    `Accounts blocked from BrewLM AI: ${blocked?.n ?? 0}`,
    pause ? `\nBrewLM AI is PAUSED (${pause.by}: ${pause.reason}). To resume:\n${pauseCmd(env, false)}` : "",
    "",
    "Used the most:",
    ...(accountsError ? [accountsError] : top.length ? top.map(line) : ["  nobody"]),
    "",
    `Used half a month's allowance or more in a day:`,
    ...(fast.length ? fast.map(line) : ["  nobody"]),
    ...(fast.length ? ["", "Each one's spending is capped by its allowance. If one looks like abuse, turn BrewLM AI off for it:", blockCmd(env, fast[0].email)] : []),
    "",
    `To pause BrewLM AI for everyone:\n${pauseCmd(env, true)}`,
  ].join("\n");
  await mail(env, `BrewLM AI daily: ${usd(spent)} spent on ${day}`, text);
  return text;
}

/* ---------------------------------- admin --------------------------------- */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** The /v1/admin/ai routes, or null when the path isn't one. */
export async function aiAdminRoutes(req: Request, env: Env, path: string): Promise<Response | null> {
  if (path !== "/v1/admin/ai" && !path.startsWith("/v1/admin/ai/")) return null;
  if (!isAdmin(req, env)) return json({ error: "unauthorized" }, 401);
  const now = Date.now();

  if (path === "/v1/admin/ai") {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    const row = await env.DB.prepare("SELECT * FROM ai_days WHERE day = ?").bind(dayOf(now)).first<AiDay>();
    return json({
      paused: await currentPause(env, now),
      today: row ? { day: row.day, spent: Math.max(0, row.last_usage - row.start_usage), balance: row.balance } : null,
      limits: limits(env),
    });
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const body = await req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : "";

  if (path === "/v1/admin/ai/pause") {
    if (typeof body.paused !== "boolean") return json({ error: "bad paused" }, 400);
    await setPause(env, body.paused ? { by: "admin", reason: reason || "paused by the admin", at: now, until: null } : null, now);
    if (env.AI_PAUSED && env.AI_PAUSED !== "0" && !body.paused)
      return json({ paused: true, note: "AI_PAUSED is still set; run `wrangler secret delete AI_PAUSED` to resume." });
    return json({ paused: body.paused });
  }
  if (path === "/v1/admin/ai/block") {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email || typeof body.blocked !== "boolean") return json({ error: "bad email or blocked" }, 400);
    const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
    if (!user) return json({ error: "no such account" }, 404);
    if (body.blocked)
      await env.DB.prepare(
        "INSERT INTO ai_blocks (user_id, reason, created_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET reason = excluded.reason"
      )
        .bind(user.id, reason || "blocked by the admin", now)
        .run();
    else await env.DB.prepare("DELETE FROM ai_blocks WHERE user_id = ?").bind(user.id).run();
    return json({ email, blocked: body.blocked });
  }
  return json({ error: "not found" }, 404);
}
