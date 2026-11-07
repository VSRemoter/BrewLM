/**
 * Sign-in emails through Resend. Without RESEND_API_KEY (local development)
 * the link is printed to the server console instead, so the whole flow can
 * be tested without sending mail.
 */
export async function sendSignInEmail(env: Env, to: string, link: string, code: string): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.log(`[dev] sign-in link for ${to} (code ${code}): ${link}`);
    return;
  }
  const text = `Click to sign in to BrewLM Sync:\n\n${link}\n\nCheck that BrewLM shows the code ${code}. The link works once, for 15 minutes.\nDidn't try to sign in? Ignore this email.`;
  const html = `<p>Click to sign in to BrewLM Sync:</p>
<p><a href="${link}" style="display:inline-block;padding:10px 20px;border-radius:999px;background:#c2410c;color:#fff;text-decoration:none;font-weight:600">Sign in to BrewLM</a></p>
<p>Check that BrewLM shows the code <b>${code}</b>. The link works once, for 15 minutes.</p>
<p style="color:#888">Didn't try to sign in? Ignore this email.</p>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to, subject: "Your BrewLM sign-in link", text, html }),
  });
  if (!res.ok) throw new Error(`email: Resend HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

/** A plain-text email to the admin (REPORT_EMAIL), or printed locally without one. */
export async function sendAdminEmail(env: Env, subject: string, text: string): Promise<void> {
  if (!env.RESEND_API_KEY || !env.REPORT_EMAIL) {
    console.log(`[dev] admin email "${subject}":\n${text}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: env.REPORT_EMAIL, subject, text }),
  });
  if (!res.ok) throw new Error(`email: Resend HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

/** A shared link was reported: tell the admin. */
export async function sendReportEmail(env: Env, shareId: string, reason: string, count: number): Promise<void> {
  const takeDown = `curl -X POST ${env.PUBLIC_URL.replace(/\/$/, "")}/v1/admin/shares/${shareId} -H "authorization: Bearer $ADMIN_TOKEN" -d '{"disabled":true}'`;
  const text = `Shared link ${shareId} was reported (${count} report${count === 1 ? "" : "s"} so far).\n\nReason given:\n${reason}\n\nThe server can't read the link. To take it down:\n${takeDown}\n\nTo bring it back, send "disabled":false instead.`;
  await sendAdminEmail(env, `BrewLM: shared link reported (${shareId.slice(0, 8)})`, text);
}
