/**
 * Request limits per signed-in account.
 *
 * - Per minute: the ACCOUNT_RATE binding (wrangler.jsonc), for bursts.
 * - Per UTC day: DAILY_REQUESTS. Counting every request in D1 would cost a
 *   write each, so one request in SAMPLE adds SAMPLE to the day's count
 *   (request_days). Over the cap, this isolate remembers the account until
 *   the day ends; other isolates find out at their next sample.
 *
 * Real use stays far below the daily cap: four devices syncing every 30
 * seconds all day is about 12,000 requests, and a first sync of a large
 * library a few tens of thousands more. The cap is there for scripts: at 600
 * a minute all month, one account would cost about $13 in Cloudflare requests.
 */

export const DAILY_REQUESTS = 100_000;
export const SAMPLE = 50;
/** Days of counts kept (the hourly cron deletes older ones). */
const KEEP_DAYS = 2;

export const SLOW_DOWN = "Too many requests. Wait a minute and try again.";
export const DAILY_LIMIT =
  "This account has made an unusually large number of requests today, so the server is pausing it until midnight UTC. If that's a mistake, write to contact@brewlm.com.";

const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

/** Accounts over today's cap, as this isolate knows them. */
const over = new Map<string, string>();

/** null when the request may go ahead; otherwise the message for a 429. */
export async function overLimit(env: Env, userId: string, now = Date.now(), random = Math.random): Promise<string | null> {
  const day = dayOf(now);
  if (over.get(userId) === day) return DAILY_LIMIT;
  if (!(await env.ACCOUNT_RATE.limit({ key: userId })).success) return SLOW_DOWN;
  if (random() * SAMPLE >= 1) return null;
  const row = await env.DB.prepare(
    `INSERT INTO request_days (user_id, day, n) VALUES (?, ?, ?)
     ON CONFLICT (user_id, day) DO UPDATE SET n = n + excluded.n RETURNING n`
  )
    .bind(userId, day, SAMPLE)
    .first<{ n: number }>();
  if (!row || row.n <= DAILY_REQUESTS) return null;
  if (over.size > 10_000) over.clear();
  over.set(userId, day);
  console.warn(`limits: ${userId} passed ${DAILY_REQUESTS} requests on ${day}`);
  return DAILY_LIMIT;
}

/** Hourly: forget old days' counts. */
export async function sweepRequestDays(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare("DELETE FROM request_days WHERE day < ?").bind(dayOf(now - KEEP_DAYS * 86_400_000)).run();
}
