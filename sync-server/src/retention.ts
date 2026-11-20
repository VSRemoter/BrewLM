/**
 * Synced data of accounts without a plan (a trial that ended, a plan that was
 * cancelled). It stays read-only for a while, so a lapsed account can still
 * download its library; after LAPSED_DELETE_DAYS (wrangler.jsonc; "0" = never)
 * the server's copy is deleted: the vault's files and records and the
 * account's shared links. The account, its key envelope and every device's
 * own copy stay. If the account gets a plan again, its devices see the vault's
 * new generation and upload their library again (vault.ts wipe, the app's
 * sync.ts).
 *
 * Nothing is deleted without notice: a first email WARN_FIRST_DAYS before the
 * date, a last one WARN_LAST_DAYS before, and the date moves later if the
 * first email went out late (never less than WARN_FIRST_DAYS of notice).
 * Accounts with nothing stored get no email. Runs hourly, a batch at a time.
 */
import type { User } from "./auth";
import { entitlement } from "./billing";
import { sendUserEmail } from "./email";
import { destroyOwnerShares, sharedBytes } from "./shares";

const DAY = 86_400_000;
const WARN_FIRST_DAYS = 30;
const WARN_LAST_DAYS = 7;
const BATCH = 25;
/** R2 pages (1,000 files each) deleted per account per run; a bigger vault finishes on later runs. */
const WIPE_PAGES = 5;
/** Plan statuses that may still be live (billing.ts PAYING). */
const PAYING = ["active", "trialing", "past_due"];

export function deleteAfterDays(env: Env): number {
  const n = Number(env.LAPSED_DELETE_DAYS ?? "180");
  return Number.isFinite(n) && n > 0 ? n : 0;
}

interface Retention {
  user_id: string;
  lapsed_at: number;
  delete_at: number | null;
  warned_first_at: number | null;
  warned_last_at: number | null;
  deleted_at: number | null;
  next_at: number;
}

interface Candidate extends User {
  lapsed: number;
  had_plan: number;
}

const longDate = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function warning(c: Candidate, used: number, deleteAt: number, last: boolean): { subject: string; text: string } {
  const ended = c.had_plan ? "BrewLM Sync plan ended" : "BrewLM Sync free trial ended";
  const subject = last
    ? `Your BrewLM library leaves the server on ${longDate(deleteAt)}`
    : `Your BrewLM library will be deleted from the server on ${longDate(deleteAt)}`;
  const text = `Your ${ended} on ${longDate(c.lapsed)}. Since then, your synced library (${size(used)}) has stayed on BrewLM's server, read-only.

On ${longDate(deleteAt)}, BrewLM will delete the server's copy: your synced notebooks, files and shared links. The copies on your own devices are not touched, and your account stays.

To keep your library on the server, choose a plan in BrewLM → Settings → Sync before then. If you choose one later, your devices upload their library again.

Questions? Reply to this email.`;
  return { subject, text };
}

async function save(env: Env, userId: string, fields: Partial<Omit<Retention, "user_id">>): Promise<void> {
  const cols = Object.keys(fields);
  await env.DB.prepare(`UPDATE retention SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE user_id = ?`)
    .bind(...cols.map((c) => fields[c as keyof typeof fields] ?? null), userId)
    .run();
}

/** Hourly. Returns what it did, for the log. */
export async function retentionSweep(env: Env, now = Date.now()): Promise<{ checked: number; warned: number; deleted: number }> {
  const out = { checked: 0, warned: 0, deleted: 0 };
  const days = deleteAfterDays(env);
  if (!days) return out;
  const lapsed = `CASE WHEN s.user_id IS NULL THEN u.trial_ends_at ELSE coalesce(s.current_period_end, s.updated_at) END`;
  // Trial over, no plan that could still be live, and lapsed long enough to warn;
  // new to this sweep, lapsed again since, or due for another look.
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.email, u.created_at, u.trial_ends_at, ${lapsed} AS lapsed, s.user_id IS NOT NULL AS had_plan
     FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id LEFT JOIN retention r ON r.user_id = u.id
     WHERE u.trial_ends_at < ?1
       AND (s.user_id IS NULL OR s.status NOT IN (${PAYING.map((_, i) => `?${i + 3}`).join(", ")}) OR s.current_period_end IS NOT NULL)
       AND ${lapsed} < ?2
       AND (r.user_id IS NULL OR r.lapsed_at != ${lapsed} OR (r.deleted_at IS NULL AND r.next_at <= ?1))
     ORDER BY lapsed LIMIT ${BATCH}`
  )
    .bind(now, now - (days - WARN_FIRST_DAYS) * DAY, ...PAYING)
    .all<Candidate>();

  for (const c of results) {
    out.checked++;
    try {
      const did = await handle(env, c, days, now);
      if (did === "warned") out.warned++;
      if (did === "deleted") out.deleted++;
    } catch (e) {
      console.error(`retention ${c.id}: ${e instanceof Error ? e.message : String(e)}`);
      // Try again next hour.
    }
  }
  return out;
}

async function handle(env: Env, c: Candidate, days: number, now: number): Promise<"warned" | "deleted" | null> {
  // The plan rules decide (a renewal still in its grace days counts as a plan).
  if ((await entitlement(env, c)).canSync) {
    await env.DB.prepare("DELETE FROM retention WHERE user_id = ?").bind(c.id).run();
    return null;
  }
  let r = await env.DB.prepare("SELECT * FROM retention WHERE user_id = ?").bind(c.id).first<Retention>();
  if (!r || r.lapsed_at !== c.lapsed) {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO retention (user_id, lapsed_at, delete_at, warned_first_at, warned_last_at, deleted_at, next_at)
       VALUES (?, ?, NULL, NULL, NULL, NULL, 0)`
    )
      .bind(c.id, c.lapsed)
      .run();
    r = { user_id: c.id, lapsed_at: c.lapsed, delete_at: null, warned_first_at: null, warned_last_at: null, deleted_at: null, next_at: 0 };
  }

  const vault = env.VAULT.get(env.VAULT.idFromName(c.id));
  const used = (await vault.usage()).total + (await sharedBytes(env, c.id));

  if (!r.warned_first_at) {
    if (used === 0) {
      // Nothing stored: nothing to warn about or delete (without a plan, nothing can be added).
      await save(env, c.id, { deleted_at: now });
      return null;
    }
    const deleteAt = Math.max(c.lapsed + days * DAY, now + WARN_FIRST_DAYS * DAY);
    const mail = warning(c, used, deleteAt, false);
    await sendUserEmail(env, c.email, mail.subject, mail.text);
    await save(env, c.id, { delete_at: deleteAt, warned_first_at: now, next_at: deleteAt - WARN_LAST_DAYS * DAY });
    return "warned";
  }

  const deleteAt = r.delete_at ?? now;
  if (!r.warned_last_at) {
    if (now < deleteAt - WARN_LAST_DAYS * DAY) {
      await save(env, c.id, { next_at: deleteAt - WARN_LAST_DAYS * DAY });
      return null;
    }
    const mail = warning(c, used, deleteAt, true);
    await sendUserEmail(env, c.email, mail.subject, mail.text);
    await save(env, c.id, { warned_last_at: now, next_at: deleteAt });
    return "warned";
  }

  if (now < deleteAt) {
    await save(env, c.id, { next_at: deleteAt });
    return null;
  }

  // Both warnings went out and the date has come: delete the server's copy.
  for (let page = 0; page < WIPE_PAGES; page++) {
    const res = await vault.wipe(c.id);
    if (res.done) {
      if (!(await destroyOwnerShares(env, c.id))) break;
      await save(env, c.id, { deleted_at: now });
      console.log(`retention: deleted the synced data of ${c.id} (${size(used)})`);
      return "deleted";
    }
  }
  // More to delete: carry on next hour.
  await save(env, c.id, { next_at: now });
  return null;
}
