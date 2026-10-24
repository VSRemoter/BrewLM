/**
 * Email sign-in for BrewLM Sync, built for a desktop app that can't receive a
 * browser redirect:
 *
 *   1. The app POSTs /v1/auth/start { email } and gets a secret pending id
 *      plus a 4-digit code to show. The email gets a one-time link.
 *   2. The link opens a page that shows the same code and a "Yes, sign in"
 *      button. Opening the link alone never signs anyone in, because email
 *      security scanners open links; and matching codes stop someone else's
 *      sign-in attempt from being approved by accident.
 *   3. The app polls /v1/auth/poll { pendingId } and receives a session token
 *      once, after the button was pressed.
 *
 * Only SHA-256 hashes of the pending id, link token and session are stored.
 */
import { sendSignInEmail } from "./email";

export const SIGN_IN_TTL_MS = 15 * 60 * 1000;
export const TRIAL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_SIGN_INS_PER_HOUR = 5;
/** Per network address, across emails: stops the server being used to spam people. */
const MAX_SIGN_INS_PER_IP_HOUR = 20;
/** A session unused this long stops working (each use extends it). */
export const SESSION_IDLE_MS = 90 * 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

export interface User {
  id: string;
  email: string;
  created_at: number;
  trial_ends_at: number;
}

const enc = new TextEncoder();

export async function sha256(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · BrewLM</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#faf6f1;color:#2a1d14;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  main{max-width:420px;margin:24px;padding:32px;background:#fff;border:1px solid #eadfd3;border-radius:18px;text-align:center}
  h1{font-size:20px;margin:0 0 10px} p{color:#6b5a4d;margin:8px 0}
  .code{font:700 30px/1 ui-monospace,Menlo,monospace;letter-spacing:.3em;color:#2a1d14;margin:18px 0}
  button{margin-top:16px;border:0;border-radius:999px;background:#c2410c;color:#fff;font:600 15px sans-serif;padding:11px 22px;cursor:pointer}
  @media (prefers-color-scheme:dark){body{background:#1b1410;color:#f3e9df}main{background:#241a14;border-color:#3a2c22}p{color:#bfae9f}.code{color:#f3e9df}}
</style></head><body><main>${body}</main></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" } }
  );
}

/** POST /v1/auth/start { email } → { pendingId, code, expiresAt } */
export async function startSignIn(req: Request, env: Env): Promise<Response> {
  const body = await req.json<{ email?: unknown }>().catch(() => ({}) as { email?: unknown });
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email)) return json({ error: "That doesn't look like an email address." }, 400);

  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const ip = req.headers.get("cf-connecting-ip") ?? "";
  const recent = await env.DB.prepare(
    "SELECT sum(email = ?) AS byEmail, sum(ip = ? AND ip != '') AS byIp FROM sign_ins WHERE created_at > ?"
  )
    .bind(email, ip, hourAgo)
    .first<{ byEmail: number | null; byIp: number | null }>();
  if ((recent?.byEmail ?? 0) >= MAX_SIGN_INS_PER_HOUR || (recent?.byIp ?? 0) >= MAX_SIGN_INS_PER_IP_HOUR)
    return json({ error: "Too many sign-in emails. Try again in an hour." }, 429);
  // Old attempts are no use to anyone; keep the table small.
  await env.DB.prepare("DELETE FROM sign_ins WHERE created_at < ?").bind(now - 24 * 60 * 60 * 1000).run();

  const pendingId = randomToken();
  const token = randomToken();
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, "0");
  const expiresAt = now + SIGN_IN_TTL_MS;
  await env.DB.prepare(
    "INSERT INTO sign_ins (pending_hash, token_hash, email, code, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(await sha256(pendingId), await sha256(token), email, code, now, expiresAt, ip)
    .run();

  const link = `${env.PUBLIC_URL.replace(/\/$/, "")}/v1/auth/verify?token=${encodeURIComponent(token)}`;
  await sendSignInEmail(env, email, link, code);
  return json({ pendingId, code, expiresAt });
}

async function pendingByToken(env: Env, token: string) {
  return env.DB.prepare("SELECT * FROM sign_ins WHERE token_hash = ?")
    .bind(await sha256(token))
    .first<{ email: string; code: string; expires_at: number; approved_at: number | null; consumed_at: number | null }>();
}

/** GET shows the confirm page; POST (the button) approves. */
export async function verifySignIn(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const token = req.method === "POST" ? String((await req.formData()).get("token") ?? "") : (url.searchParams.get("token") ?? "");
  const row = token ? await pendingByToken(env, token) : null;
  if (!row || row.expires_at <= Date.now() || row.consumed_at)
    return page("Link expired", `<h1>This link has expired</h1><p>Start signing in again from BrewLM.</p>`);
  if (row.approved_at)
    return page("Signed in", `<h1>You're signed in</h1><p>You can close this page and return to BrewLM.</p>`);

  if (req.method !== "POST")
    return page(
      "Sign in",
      `<h1>Sign in to BrewLM?</h1>
       <p>as <b>${escapeHtml(row.email)}</b></p>
       <p>Check that BrewLM is showing this code:</p>
       <div class="code">${escapeHtml(row.code)}</div>
       <form method="post"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit">Yes, sign in</button></form>
       <p style="font-size:13px;margin-top:18px">Didn't try to sign in? Close this page; nothing happens.</p>`
    );

  await env.DB.prepare("UPDATE sign_ins SET approved_at = ? WHERE token_hash = ? AND approved_at IS NULL")
    .bind(Date.now(), await sha256(token))
    .run();
  return page("Signed in", `<h1>You're signed in</h1><p>You can close this page and return to BrewLM.</p>`);
}

/** POST /v1/auth/poll { pendingId } → { status: "pending" | "expired" } or, once, { status: "ok", session, email, vault } */
export async function pollSignIn(req: Request, env: Env): Promise<Response> {
  const body = await req.json<{ pendingId?: unknown }>().catch(() => ({}) as { pendingId?: unknown });
  if (typeof body.pendingId !== "string") return json({ error: "bad pendingId" }, 400);
  const pendingHash = await sha256(body.pendingId);
  const row = await env.DB.prepare("SELECT * FROM sign_ins WHERE pending_hash = ?")
    .bind(pendingHash)
    .first<{ email: string; expires_at: number; approved_at: number | null; consumed_at: number | null }>();
  const now = Date.now();
  if (!row || row.consumed_at || row.expires_at <= now) return json({ status: "expired" });
  if (!row.approved_at) return json({ status: "pending" });

  // Approved: consume it (once), create the account on first sign-in, open a session.
  const claimed = await env.DB.prepare("UPDATE sign_ins SET consumed_at = ? WHERE pending_hash = ? AND consumed_at IS NULL")
    .bind(now, pendingHash)
    .run();
  if (claimed.meta.changes !== 1) return json({ status: "expired" });
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at, trial_ends_at) VALUES (?, ?, ?, ?)")
    .bind(crypto.randomUUID(), row.email, now, now + TRIAL_MS)
    .run();
  const user = (await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(row.email).first<User>())!;
  const session = randomToken();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(session), user.id, now, now)
    .run();
  return json({ status: "ok", session, email: user.email, vault: user.id });
}

/** The signed-in user for a request's bearer token, or null. */
export async function userForSession(env: Env, bearer: string): Promise<User | null> {
  if (!bearer) return null;
  const hash = await sha256(bearer);
  const user = await env.DB.prepare(
    "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.last_used_at > ?"
  )
    .bind(hash, Date.now() - SESSION_IDLE_MS)
    .first<User>();
  if (user) {
    // Touch at most hourly: cheap enough, and enough to spot stale sessions later.
    await env.DB.prepare("UPDATE sessions SET last_used_at = ? WHERE token_hash = ? AND last_used_at < ?")
      .bind(Date.now(), hash, Date.now() - 60 * 60 * 1000)
      .run();
  }
  return user;
}

/** DELETE /v1/auth/session — sign this device out. */
export async function signOut(env: Env, bearer: string): Promise<Response> {
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(bearer)).run();
  return new Response(null, { status: 204 });
}
